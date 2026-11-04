const test = require('node:test');
const assert = require('node:assert/strict');
const rows = { own: { id:'own',agentId:'sales-a' }, other:{ id:'other',agentId:'sales-b' } };
const dbPath = require.resolve('../db');
const model = { findFirst:async({where})=>rows[where.id]||null,findUnique:async({where})=>rows[where.id]||null };
require.cache[dbPath]={id:dbPath,filename:dbPath,loaded:true,exports:{prisma:{client:model,quote:model}}};
const {recordAccess,scopedIo}=require('../middleware/recordAccess');
function response(){return {statusCode:200,status(code){this.statusCode=code;return this;},json(data){this.body=data;return this;}};}
async function run(path,method='GET',body={},role='sales_executive'){const req={path,method,body,query:{agentId:'sales-b'},user:{id:'sales-a',role}};const res=response();let passed=false;await recordAccess('client')(req,res,()=>passed=true);return{req,res,passed};}
test('agents cannot read or modify another owner record',async()=>{for(const method of ['GET','PUT','DELETE'])assert.equal((await run('/other',method)).res.statusCode,403);});
test('missing record updates fail instead of reporting success',async()=>assert.equal((await run('/missing','PUT',{city:'Delhi'},'admin')).res.statusCode,404));
test('agent ownership cannot be supplied through query or create body',async()=>{assert.equal((await run('/')).req.query.agentId,'sales-a');assert.equal((await run('/','POST',{agentId:'sales-b'})).req.body.agentId,'sales-a');});
test('agents cannot reassign or overwrite an existing ID',async()=>{assert.equal((await run('/own','PUT',{agentId:'sales-b'})).res.statusCode,403);assert.equal((await run('/','POST',{id:'other'})).res.statusCode,409);});
test('admins can access other records and owner can access own record',async()=>{assert.equal((await run('/other','GET',{},'admin')).passed,true);assert.equal((await run('/own')).passed,true);});
test('customer events are sent only to the owner and admin rooms',()=>{let rooms,event;const req={user:{id:'sales-a'},app:{get:()=>({to:value=>{rooms=value;return{emit:name=>event=name};}})}};scopedIo(req).to('agents_group').emit('client:new',{agentId:'sales-b'});assert.deepEqual(rooms,['crm:admins','agent:sales-b']);assert.equal(event,'client:new');});
