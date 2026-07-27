/** @type {import('jest').Config} */
module.exports = {
	preset: 'ts-jest',
	testEnvironment: 'node',
	roots: ['<rootDir>/tests'],
	clearMocks: true,
	collectCoverageFrom: ['src/**/*.ts', '!src/index.ts', '!src/webview/**/*.tsx'],
	moduleNameMapper: {
		'^api$': '<rootDir>/tests/fakes/joplinApi.ts',
	},
};
