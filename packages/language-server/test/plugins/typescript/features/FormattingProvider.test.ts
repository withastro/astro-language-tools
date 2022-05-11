import { expect } from 'chai';
import { Range } from 'vscode-languageserver-types';
import { FormattingProviderImpl } from '../../../../src/plugins/typescript/features/FormattingProvider';
import { LanguageServiceManager } from '../../../../src/plugins/typescript/LanguageServiceManager';
import { createEnvironment, defaultFormattingOptions } from '../../../utils';

describe('TypeScript Plugin#HoverProvider', () => {
	function setup(filePath: string) {
		const env = createEnvironment(filePath, 'typescript', 'formatting');
		const languageServiceManager = new LanguageServiceManager(env.docManager, [env.fixturesDir], env.configManager);
		const provider = new FormattingProviderImpl(languageServiceManager, env.configManager);

		return {
			...env,
			provider,
		};
	}

	it('provide formatting', async () => {
		const { provider, document } = setup('basic.astro');

		const formatting = await provider.formatDocument(document, defaultFormattingOptions);

		expect(formatting).to.deep.equal([
			{
				newText: '    ',
				range: Range.create(2, 0, 2, 2),
			},
			{
				newText: '\n',
				range: Range.create(5, 0, 5, 0),
			},
		]);
	});

	it('format script tags', async () => {
		const { provider, document } = setup('scriptTag.astro');

		const formatting = await provider.formatDocument(document, defaultFormattingOptions);

		expect(formatting).to.deep.equal([
			{
				newText: '  ',
				range: Range.create(1, 0, 1, 0),
			},
		]);
	});
});
