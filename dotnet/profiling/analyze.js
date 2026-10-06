const fs=require("fs");
const file=process.argv[2];
const d=JSON.parse(fs.readFileSync(file,"utf8"));
const frames=d.shared.frames;
const pseudo=/^(UNMANAGED_CODE_TIME|CPU_TIME)$/;
const idle=/WaitForSignal|LowLevelLifoSemaphore|GateThreadStart|GetQueuedCompletionStatus|WorkerThreadStart|\.Wait\(|WaitOneNoCheck|PollGC/;
const self=new Array(frames.length).fill(0);
let grand=0,idleT=0;
for(const p of d.profiles){
  const stack=[];let last=p.startValue;
  for(const e of p.events){
    const dt=e.at-last;last=e.at;
    if(dt>0&&stack.length){
      let k=stack.length-1;
      while(k>=0&&pseudo.test(frames[stack[k]].name))k--;
      if(k>=0){const nm=frames[stack[k]].name;
        if(idle.test(nm))idleT+=dt; else {self[stack[k]]+=dt;grand+=dt;}}
    }
    if(e.type==="O")stack.push(e.frame);
    else if(e.type==="C"){const i=stack.lastIndexOf(e.frame);if(i>=0)stack.splice(i,1);}
  }
}
function short(n){return n.replace(/class |value class |unsigned |System\.Private\.CoreLib\.il!|il!|\(.*/g,"").replace(/^System\./,"S.");}
const idx=[...frames.keys()].filter(i=>self[i]>0).sort((a,b)=>self[b]-self[a]);
console.log("\n######## "+file+"   activeCPU="+Math.round(grand)+"  idleExcl="+Math.round(idleT)+" ########");
let shown=0;
for(const i of idx){if(shown++>=28)break;console.log((self[i]/grand*100).toFixed(1).padStart(5)+"%  "+short(frames[i].name).slice(0,78));}
