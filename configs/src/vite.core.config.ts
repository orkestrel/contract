import { defineConfig } from 'vite'
import { srcCore, resolveWorkspacePath } from '../../vite.config'

export default defineConfig(
	srcCore({
		build: {
			lib: {
				entry: resolveWorkspacePath('src/core/index.ts'),
				formats: ['cjs'],
				fileName: () => 'index.cjs',
			},
			outDir: 'dist/src/core',
		},
	}),
)
