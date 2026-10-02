// For each ordered group of classic scripts sharing one global scope, flag
// top-level code that, at load time, reads a binding declared in a LATER file.
const fs=require('fs'),acorn=require('acorn');
const OUT=process.argv[2];
const idx=fs.readFileSync(OUT+'/index.html','utf8');
const main=[...idx.matchAll(/<script defer src="([^"]+)"/g)].map(m=>m[1]);
const wk=[...fs.readFileSync(OUT+'/worker/mesh-worker.js','utf8').matchAll(/"(m\d\d-[^"]+)"/g)].map(m=>'worker/'+m[1]);
function check(group,label){
  const decl={};const asts={};
  group.forEach((f,i)=>{
    const ast=acorn.parse(fs.readFileSync(OUT+'/'+f,'utf8'),{ecmaVersion:'latest',sourceType:'script'});
    asts[f]=ast;
    for(const s of ast.body){
      if(s.type==='FunctionDeclaration'||s.type==='ClassDeclaration') decl[s.id.name]=i;
      if(s.type==='VariableDeclaration') for(const d of s.declarations) if(d.id.type==='Identifier') decl[d.id.name]=i;
    }
  });
  let bad=0;
  group.forEach((f,i)=>{
    for(const s of asts[f].body){
      if(s.type==='FunctionDeclaration'||s.type==='ClassDeclaration') continue;
      // walk, but don't descend into function bodies (deferred execution)...
      // ...except IIFEs, which run now.
      const refs=[];
      (function visit(n,parentIsCall){
        if(!n||typeof n.type!=='string')return;
        const isFn=/Function/.test(n.type);
        if(isFn && !parentIsCall) return;
        if(n.type==='Identifier') refs.push(n.name);
        for(const k of Object.keys(n)){
          if(k==='type'||k==='loc')continue;
          const v=n[k];
          if(n.type==='MemberExpression'&&k==='property'&&!n.computed)continue;
          if(n.type==='Property'&&k==='key'&&!n.computed)continue;
          const pc=(n.type==='CallExpression'||n.type==='NewExpression')&&k==='callee';
          if(Array.isArray(v))v.forEach(c=>visit(c,k==='arguments'));else if(v&&typeof v.type==='string')visit(v,pc);
        }
      })(s,false);
      for(const r of new Set(refs)) if(decl[r]!==undefined && decl[r]>i){bad++;console.log(label,f,'line',s.loc?.start?.line??'','uses',r,'from',group[decl[r]]);}
    }
  });
  console.log(label,'files',group.length,'forward refs at load:',bad,'top-level names:',Object.keys(decl).length);
  return decl;
}
const d=check(main,'MAIN');
check(wk,'WORKER');

