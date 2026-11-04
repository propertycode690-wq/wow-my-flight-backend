const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'local-test-secret';
const dbPath = require.resolve('../db');
require.cache[dbPath] = { id:dbPath, filename:dbPath, loaded:true, exports:{prisma:{user:{findUnique:async({where})=>where.id==='active'?{id:'active',role:'sales_executive',status:'active'}:null}}}};
const { requireAuth } = require('../middleware/auth');
const { enforceRole } = require('../middleware/access');
function response(){return {statusCode:200,status(code){this.statusCode=code;return this;},json(data){this.body=data;return this;}};}
test('missing token is rejected even with the old bypass environment flag',async()=>{process.env.AUTH_ENFORCE='false';const res=response();await requireAuth({headers:{}},res,()=>assert.fail('must reject'));assert.equal(res.statusCode,401);});
test('invalid token is rejected',async()=>{const res=response();await requireAuth({headers:{authorization:'Bearer invalid'}},res,()=>assert.fail('must reject'));assert.equal(res.statusCode,401);});
test('deleted user cannot reuse an old token',async()=>{const res=response();const token=jwt.sign({id:'deleted',role:'super_admin'},process.env.JWT_SECRET);await requireAuth({headers:{authorization:'Bearer '+token}},res,()=>assert.fail('must reject'));assert.equal(res.statusCode,401);});
test('role is read from the current database account, not stale token claims',async()=>{const res=response();const token=jwt.sign({id:'active',role:'super_admin'},process.env.JWT_SECRET);const req={headers:{authorization:'Bearer '+token}};let passed=false;await requireAuth(req,res,()=>passed=true);assert.equal(passed,true);assert.equal(req.user.role,'sales_executive');});
test('sales executive cannot access management APIs',()=>{const res=response();enforceRole({user:{role:'sales_executive'},path:'/permission-control/roles',method:'GET'},res,()=>assert.fail('must reject'));assert.equal(res.statusCode,403);});
test('admin cannot edit role definitions',()=>{const res=response();enforceRole({user:{role:'admin'},path:'/permission-control/roles',method:'POST'},res,()=>assert.fail('must reject'));assert.equal(res.statusCode,403);});
test('super admin can manage role definitions',()=>{let passed=false;enforceRole({user:{role:'super_admin'},path:'/permission-control/roles',method:'POST'},response(),()=>passed=true);assert.equal(passed,true);});
