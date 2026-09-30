import {describe,it,expect} from 'vitest';
import {buildCommandLine} from '../src/build.js';
describe('buildCommandLine',()=>{
 it('makes project-local build tools available after loading Node',()=>{const line=buildCommandLine('/home/tester/demo',{VERCEL:'1'},'tsc --noEmit && vite build');expect(line).toContain('. "$HOME/.nvm/nvm.sh"');expect(line).toContain("export PATH='/home/tester/demo/node_modules/.bin':$PATH");expect(line).toContain("export VERCEL='1'");expect(line.endsWith('tsc --noEmit && vite build')).toBe(true);});
 it('quotes project paths containing shell characters',()=>{const line=buildCommandLine("/home/tester's/demo $project",{},'npm run build');expect(line).toContain("cd '/home/tester'\\''s/demo $project'");expect(line).not.toMatch(/;\s*&&/);});
});
