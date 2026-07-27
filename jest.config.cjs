/** @type {import('jest').Config} */
module.exports = {
	preset: 'ts-jest',
	testEnvironment: 'node',
	roots: ['<rootDir>/tests'],
	setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
	clearMocks: true,
	collectCoverageFrom: ['src/**/*.ts', '!src/index.ts', '!src/webview/**/*.tsx'],
	moduleNameMapper: {
		'^api$': '<rootDir>/tests/fakes/joplinApi.ts',
		'^api/(.*)$': '<rootDir>/api/$1',
		'^react-markdown$': '<rootDir>/tests/fakes/reactMarkdown.tsx',
		'^remark-gfm$': '<rootDir>/tests/fakes/remarkGfm.ts',
	},
};
