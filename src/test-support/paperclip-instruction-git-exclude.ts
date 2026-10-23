/**
 * Paperclip's `instructionGitExcludeProgram` (tog.22,
 * server/src/services/agent-instruction-files.ts), verbatim. Before every run
 * of an agent with an instructions bundle, Paperclip runs
 * `node -e <this> <remoteCwd>` through Execute (agent-directory-working-copies.ts)
 * and fails the run with "Could not exclude agent files from task Git staging"
 * when it exits non-zero. It refuses a `.paperclip-runtime` that is a symlink.
 */
export const PAPERCLIP_INSTRUCTION_GIT_EXCLUDE_PROGRAM = String.raw`
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const cwd=fs.realpathSync(process.argv[1]);
const root=path.join(cwd,'.paperclip-runtime'),filename=path.join(root,'.gitignore');
const stat=(name)=>{try{return fs.lstatSync(name)}catch(e){if(e.code==='ENOENT')return null;throw e}};
const directory=stat(root);
if(directory && (directory.isSymbolicLink() || !directory.isDirectory()))throw Error('Unsafe runtime exclusion directory');
if(!directory)fs.mkdirSync(root,{mode:0o700});
const existing=stat(filename);
if(existing && (existing.isSymbolicLink() || !existing.isFile()))throw Error('Unsafe runtime exclusion file');
const temporary=path.join(root,'.ignore-'+crypto.randomUUID()+'.tmp');
try{fs.writeFileSync(temporary,'*\n',{flag:'wx',mode:0o600});fs.renameSync(temporary,filename)}finally{fs.rmSync(temporary,{force:true})}
`;
