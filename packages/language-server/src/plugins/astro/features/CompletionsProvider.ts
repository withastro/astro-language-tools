import type { AppCompletionList, CompletionsProvider } from '../../interfaces';
import { FunctionDeclaration, FunctionTypeNode } from 'typescript';
import type { AstroDocument } from '../../../core/documents';
import {
	CompletionContext,
	Position,
	CompletionList,
	CompletionItem,
	CompletionItemKind,
	CompletionTriggerKind,
	InsertTextFormat,
	MarkupContent,
	MarkupKind,
	TextEdit,
} from 'vscode-languageserver';
import ts from 'typescript';
import { LanguageServiceManager as TypeScriptLanguageServiceManager } from '../../typescript/LanguageServiceManager';
import { isInComponentStartTag, isInsideExpression } from '../../../core/documents/utils';
import { isPossibleComponent } from '../../../utils';
import { toVirtualAstroFilePath, toVirtualFilePath } from '../../typescript/utils';
import { getLanguageService } from 'vscode-html-languageservice';
import { astroDirectives } from '../../html/features/astro-attributes';
import { removeDataAttrCompletion } from '../../html/utils';

type LastCompletion = {
	tag: string;
	documentVersion: number;
	completions: CompletionItem[] | null;
};

export class CompletionsProviderImpl implements CompletionsProvider {
	private readonly languageServiceManager: TypeScriptLanguageServiceManager;
	private lastCompletion: LastCompletion | null = null;

	public directivesHTMLLang = getLanguageService({
		customDataProviders: [astroDirectives],
		useDefaultDataProvider: false,
	});

	constructor(languageServiceManager: TypeScriptLanguageServiceManager) {
		this.languageServiceManager = languageServiceManager;
	}

	async getCompletions(
		document: AstroDocument,
		position: Position,
		completionContext?: CompletionContext
	): Promise<AppCompletionList | null> {
		let items: CompletionItem[] = [];

		if (completionContext?.triggerCharacter === '-') {
			const frontmatter = this.getComponentScriptCompletion(document, position);
			if (frontmatter) items.push(frontmatter);
		}

		const html = document.html;
		const offset = document.offsetAt(position);
		const node = html.findNodeAt(offset);

		if (isInComponentStartTag(html, offset) && !isInsideExpression(document.getText(), node.start, offset)) {
			const { completions: props, componentFilePath } = await this.getPropCompletionsAndFilePath(
				document,
				position,
				completionContext
			);

			if (props.length) {
				items.push(...props);
			}

			const isAstro = componentFilePath?.endsWith('.astro');
			if (!isAstro) {
				const directives = removeDataAttrCompletion(this.directivesHTMLLang.doComplete(document, position, html).items);
				items.push(...directives);
			}
		}

		return CompletionList.create(items, true);
	}

	private getComponentScriptCompletion(document: AstroDocument, position: Position): CompletionItem | null {
		const base: CompletionItem = {
			kind: CompletionItemKind.Snippet,
			label: '---',
			sortText: '\0',
			preselect: true,
			detail: 'Component script',
			insertTextFormat: InsertTextFormat.Snippet,
			commitCharacters: [],
		};

		const prefix = document.getLineUntilOffset(document.offsetAt(position));

		if (document.astroMeta.frontmatter.state === null) {
			return {
				...base,
				insertText: '---\n$0\n---',
				textEdit: prefix.match(/^\s*\-+/)
					? TextEdit.replace({ start: { ...position, character: 0 }, end: position }, '---\n$0\n---')
					: undefined,
			};
		}

		if (document.astroMeta.frontmatter.state === 'open') {
			return {
				...base,
				insertText: '---',
				textEdit: prefix.match(/^\s*\-+/)
					? TextEdit.replace({ start: { ...position, character: 0 }, end: position }, '---')
					: undefined,
			};
		}
		return null;
	}

	private async getPropCompletionsAndFilePath(
		document: AstroDocument,
		position: Position,
		completionContext?: CompletionContext
	): Promise<{ completions: CompletionItem[]; componentFilePath: string | null }> {
		const offset = document.offsetAt(position);

		const html = document.html;
		const node = html.findNodeAt(offset);

		if (!isPossibleComponent(node)) {
			return { completions: [], componentFilePath: null };
		}

		const inAttribute = node.start + node.tag!.length < offset;
		if (!inAttribute) {
			return { completions: [], componentFilePath: null };
		}

		if (completionContext?.triggerCharacter === '/' || completionContext?.triggerCharacter === '>') {
			return { completions: [], componentFilePath: null };
		}

		// If inside of attribute value, skip.
		if (
			completionContext &&
			completionContext.triggerKind === CompletionTriggerKind.TriggerCharacter &&
			completionContext.triggerCharacter === '"'
		) {
			return { completions: [], componentFilePath: null };
		}

		const componentName = node.tag!;
		const { lang, tsDoc } = await this.languageServiceManager.getLSAndTSDoc(document);

		// Get the source file
		const tsFilePath = toVirtualAstroFilePath(tsDoc.filePath);

		const program = lang.getProgram();
		const sourceFile = program?.getSourceFile(tsFilePath);
		const typeChecker = program?.getTypeChecker();
		if (!sourceFile || !typeChecker) {
			return { completions: [], componentFilePath: null };
		}

		// Get the import statement
		const imp = this.getImportedSymbol(sourceFile, componentName);

		const importType = imp && typeChecker.getTypeAtLocation(imp);
		if (!importType) {
			return { completions: [], componentFilePath: null };
		}

		const symbol = importType.getSymbol();
		if (!symbol) {
			return { completions: [], componentFilePath: null };
		}

		const symbolDeclaration = symbol.declarations;
		if (!symbolDeclaration) {
			return { completions: [], componentFilePath: null };
		}

		const filePath = symbolDeclaration[0].getSourceFile().fileName;
		const componentSnapshot = await this.languageServiceManager.getSnapshot(filePath);

		if (this.lastCompletion) {
			if (
				this.lastCompletion.tag === componentName &&
				this.lastCompletion.documentVersion == componentSnapshot.version
			) {
				return { completions: this.lastCompletion.completions!, componentFilePath: filePath };
			}
		}

		// Get the component's props type
		const componentType = this.getPropType(symbolDeclaration, typeChecker);
		if (!componentType) {
			return { completions: [], componentFilePath: null };
		}

		let completionItems: CompletionItem[] = [];

		// Add completions for this component's props type properties
		const properties = componentType.getProperties().filter((property) => property.name !== 'children') || [];

		properties.forEach((property) => {
			const type = typeChecker.getTypeOfSymbolAtLocation(property, imp);
			let completionItem = this.getCompletionItemForProperty(property, typeChecker, type);
			completionItems.push(completionItem);
		});

		// Ensure that props shows up first as a completion, despite this plugin being ran after the HTML one
		completionItems = completionItems.map((item) => {
			return { ...item, sortText: '_' };
		});

		this.lastCompletion = {
			tag: componentName,
			documentVersion: componentSnapshot.version,
			completions: completionItems,
		};

		return { completions: completionItems, componentFilePath: filePath };
	}

	private getImportedSymbol(sourceFile: ts.SourceFile, identifier: string): ts.ImportSpecifier | ts.Identifier | null {
		for (let list of sourceFile.getChildren()) {
			for (let node of list.getChildren()) {
				if (ts.isImportDeclaration(node)) {
					let clauses = node.importClause;
					if (!clauses) return null;
					let namedImport = clauses.getChildAt(0);

					if (ts.isNamedImports(namedImport)) {
						for (let imp of namedImport.elements) {
							// Iterate the named imports
							if (imp.name.getText() === identifier) {
								return imp;
							}
						}
					} else if (ts.isIdentifier(namedImport)) {
						if (namedImport.getText() === identifier) {
							return namedImport;
						}
					}
				}
			}
		}

		return null;
	}

	private getPropType(declarations: ts.Declaration[], typeChecker: ts.TypeChecker): ts.Type | null {
		for (const decl of declarations) {
			const fileName = toVirtualFilePath(decl.getSourceFile().fileName);
			if (fileName.endsWith('.tsx') || fileName.endsWith('.jsx') || fileName.endsWith('.d.ts')) {
				if (!ts.isFunctionDeclaration(decl) && !ts.isFunctionTypeNode(decl)) {
					console.error(`We only support functions declarations at the moment`);
					continue;
				}

				const fn = decl as FunctionDeclaration | FunctionTypeNode;
				if (!fn.parameters.length) continue;

				const param1 = fn.parameters[0];
				const propType = typeChecker.getTypeAtLocation(param1);

				return propType;
			}
		}

		return null;
	}

	private getCompletionItemForProperty(mem: ts.Symbol, typeChecker: ts.TypeChecker, type: ts.Type) {
		const typeString = typeChecker.typeToString(type);

		let insertText = mem.name;
		switch (typeString) {
			case 'string':
				insertText = `${mem.name}="$1"`;
				break;
			case 'boolean':
				insertText = mem.name;
				break;
			default:
				insertText = `${mem.name}={$1}`;
				break;
		}

		let item: CompletionItem = {
			label: mem.name,
			detail: typeString,
			insertText: insertText,
			insertTextFormat: InsertTextFormat.Snippet,
			commitCharacters: [],
		};

		mem.getDocumentationComment(typeChecker);
		let description = mem
			.getDocumentationComment(typeChecker)
			.map((val) => val.text)
			.join('\n');

		if (description) {
			let docs: MarkupContent = {
				kind: MarkupKind.Markdown,
				value: description,
			};
			item.documentation = docs;
		}
		return item;
	}
}
