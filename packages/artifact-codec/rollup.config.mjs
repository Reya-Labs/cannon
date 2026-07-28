import commonjs from '@rollup/plugin-commonjs';
import { nodeResolve } from '@rollup/plugin-node-resolve';

export default {
  input: '.build/index.js',
  plugins: [
    commonjs(),
    nodeResolve({
      browser: true,
      preferBuiltins: false,
    }),
  ],
  output: {
    file: 'dist/index.js',
    format: 'cjs',
    exports: 'named',
    sourcemap: false,
  },
};
