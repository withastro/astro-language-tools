import { InlayHint } from 'vscode-languageserver';
import type { AstroDocument } from '../../../core/documents';
import type { InlayHintsProvider } from '../../interfaces';
import type { LanguageServiceManager } from '../LanguageServiceManager';
import { toVirtualAstroFilePath } from '../utils';
import { InlayHintKind, Range } from 'vscode-languageserver-types';
import type { ConfigManager } from '../../../core/config';

export class InlayHintsProviderImpl implements InlayHintsProvider {
	constructor(
		private languageServiceManager: LanguageServiceManager,
		private configManager: ConfigManager,
		private readonly ts: typeof import('typescript/lib/tsserverlibrary')
	) {}

	async getInlayHints(document: AstroDocument, range: Range): Promise<InlayHint[]> {
		const { lang, tsDoc } = await this.languageServiceManager.getLSAndTSDoc(document);

		const filePath = toVirtualAstroFilePath(tsDoc.filePath);
		const fragment = await tsDoc.createFragment();

		const start = fragment.offsetAt(fragment.getGeneratedPosition(range.start));
		const end = fragment.offsetAt(fragment.getGeneratedPosition(range.end));

		const tsPreferences = await this.configManager.getTSPreferences(document);

		const inlayHints = lang.provideInlayHints(filePath, { start, length: end - start }, tsPreferences);

		return inlayHints.map((hint) => {
			const result = InlayHint.create(
				fragment.getOriginalPosition(fragment.positionAt(hint.position)),
				hint.text,
				hint.kind === this.ts.InlayHintKind.Type
					? InlayHintKind.Type
					: hint.kind === this.ts.InlayHintKind.Parameter
					? InlayHintKind.Parameter
					: undefined
			);

			result.paddingLeft = hint.whitespaceBefore;
			result.paddingRight = hint.whitespaceAfter;

			return result;
		});
	}
}
