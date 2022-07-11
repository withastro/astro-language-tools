import type ts from 'typescript/lib/tsserverlibrary';
import { LocationLink, Position } from 'vscode-languageserver-types';
import type { AstroDocument } from '../../../core/documents';
import { isNotNullOrUndefined, pathToUrl } from '../../../utils';
import type { DefinitionsProvider } from '../../interfaces';
import type { LanguageServiceManager } from '../LanguageServiceManager';
import type { AstroSnapshot } from '../snapshots/DocumentSnapshot';
import {
	convertToLocationRange,
	ensureRealFilePath,
	getScriptTagSnapshot,
	isAstroFilePath,
	isFrameworkFilePath,
} from '../utils';
import { SnapshotMap } from './utils';

export class DefinitionsProviderImpl implements DefinitionsProvider {
	constructor(private languageServiceManager: LanguageServiceManager) {}

	async getDefinitions(document: AstroDocument, position: Position): Promise<LocationLink[]> {
		const { lang, tsDoc } = await this.languageServiceManager.getLSAndTSDoc(document);

		const fragmentPosition = tsDoc.getGeneratedPosition(position);
		const fragmentOffset = tsDoc.offsetAt(fragmentPosition);

		let defs: ts.DefinitionInfoAndBoundSpan | undefined;

		const html = document.html;
		const offset = document.offsetAt(position);
		const node = html.findNodeAt(offset);

		if (node.tag === 'script') {
			const {
				snapshot: scriptTagSnapshot,
				filePath: scriptFilePath,
				offset: scriptOffset,
			} = getScriptTagSnapshot(tsDoc as AstroSnapshot, document, node, position);

			defs = lang.getDefinitionAndBoundSpan(scriptFilePath, scriptOffset);

			if (defs) {
				defs.definitions = defs.definitions?.map((def) => {
					const isInSameFile = def.fileName === scriptFilePath;
					def.fileName = isInSameFile ? tsDoc.filePath : def.fileName;

					if (isInSameFile) {
						def.textSpan.start = tsDoc.offsetAt(
							scriptTagSnapshot.getOriginalPosition(scriptTagSnapshot.positionAt(def.textSpan.start))
						);
					}

					return def;
				});

				defs.textSpan.start = tsDoc.offsetAt(
					scriptTagSnapshot.getOriginalPosition(scriptTagSnapshot.positionAt(defs.textSpan.start))
				);
			}
		} else {
			defs = lang.getDefinitionAndBoundSpan(tsDoc.filePath, fragmentOffset);
		}

		if (!defs || !defs.definitions) {
			return [];
		}

		const snapshots = new SnapshotMap(this.languageServiceManager);
		snapshots.set(tsDoc.filePath, tsDoc);

		const result = await Promise.all(
			defs.definitions!.map(async (def) => {
				const snapshot = await snapshots.retrieve(def.fileName);

				const fileName = ensureRealFilePath(def.fileName);

				// For Astro, Svelte and Vue, the position is wrongly mapped to the end of the file due to the TSX output
				// So we'll instead redirect to the beginning of the file
				const isFramework = isFrameworkFilePath(def.fileName) || isAstroFilePath(def.fileName);
				const textSpan = isFramework && tsDoc.filePath !== def.fileName ? { start: 0, length: 0 } : def.textSpan;

				return LocationLink.create(
					pathToUrl(fileName),
					convertToLocationRange(snapshot, textSpan),
					convertToLocationRange(snapshot, textSpan),
					convertToLocationRange(tsDoc, defs!.textSpan)
				);
			})
		);
		return result.filter(isNotNullOrUndefined);
	}
}
