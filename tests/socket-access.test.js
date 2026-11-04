const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'unit-test-secret-only';
const dbPath = require.resolve('../db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { prisma: { user: { findUnique: async ({where}) => ({id:where.id,name:'Agent',role:'sales_executive',status:where.id==='disabled'?'inactive':'active'}) } } } };
const { installSocketAccess } = require('../middleware/socketAccess');
async function run(event,payload={},id) {
  let handler,reply,passed=false;
  const socket={data:id?{user:{id}}:{},rooms:new Set(),handshake:{auth:{token:id?jwt.sign({id},process.env.JWT_SECRET):undefined}},use:fn=>handler=fn};
  installSocketAccess(socket,{getSession:()=>({agentId:'another-agent'})});
  await handler([event,payload,value=>reply=value],()=>passed=true);
  return {passed,reply,payload};
}
test('anonymous clients cannot read staff chat or session lists',async()=>{for(const event of ['team:get_messages','team:send_message','chat:get_active_sessions','chat:accept_request'])assert.equal((await run(event)).reply.success,false);});
test('staff identity is taken from a valid session',async()=>{const r=await run('agent:register',{agentId:'admin',role:'super_admin'},'sales-a');assert.equal(r.passed,true);assert.equal(r.payload.agentId,'sales-a');});
test('cross-agent chat operations and disabled accounts are denied',async()=>{assert.equal((await run('chat:resolve_session',{sessionId:'other'},'sales-a')).passed,false);assert.equal((await run('team:get_messages',{},'disabled')).passed,false);});
test('public website visitors can start a chat but cannot post staff notes',async()=>{assert.equal((await run('chat:customer_join')).passed,true);assert.equal((await run('chat:send_message',{sessionId:'other',type:'note'})).passed,false);});
