const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { randomUUID } = require('crypto');
const { prisma } = require('../db');
const router = express.Router();
const fields = { id:true, name:true, email:true, role:true, phone:true, avatar:true, status:true, createdAt:true, updatedAt:true };
const roles = ['super_admin', 'admin', 'sales_executive'];
router.post('/login', rateLimit({ windowMs:900000, max:20, standardHeaders:true, legacyHeaders:false }), async (req,res) => {
  try {
    const {email,password} = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string' || !password) return res.status(400).json({success:false,error:'Email and password required'});
    const user = await prisma.user.findFirst({where:{email:{equals:email.trim(),mode:'insensitive'},status:'active'}});
    const valid = user?.passwordHash?.startsWith('$2') && await bcrypt.compare(password,user.passwordHash);
    if (!valid) return res.status(401).json({success:false,error:'Invalid email or password'});
    const token=jwt.sign({id:user.id,role:user.role},process.env.JWT_SECRET,{expiresIn:'12h'});
    return res.json({success:true,user:Object.fromEntries(Object.keys(fields).map(k=>[k,user[k]])),token});
  } catch (e) { console.error('[Login]',e.code||e.name);res.status(503).json({success:false,error:'Login temporarily unavailable'}); }
});
router.get('/me', async(req,res)=>{
  const user=await prisma.user.findUnique({where:{id:req.user.id},select:fields}).catch(()=>null);
  if(!user||user.status!=='active')return res.status(401).json({success:false,error:'Account unavailable'});
  res.json({success:true,data:user});
});
router.get('/',async(req,res)=>{
  try {
    const where={};
    if(req.query.role&&req.query.role!=='all')where.role=req.query.role;
    if(req.query.status&&req.query.status!=='all')where.status=req.query.status;
    if(req.query.search)where.OR=['name','email','phone'].map(k=>({[k]:{contains:String(req.query.search),mode:'insensitive'}}));
    const data=await prisma.user.findMany({where,select:fields,orderBy:{name:'asc'}});
    res.json({success:true,count:data.length,data});
  }catch{res.status(503).json({success:false,error:'Could not load users'});}
});
router.get('/:id',async(req,res)=>{
  try{const data=await prisma.user.findUnique({where:{id:req.params.id},select:fields});
  if(!data)return res.status(404).json({success:false,error:'User not found'});
  res.json({success:true,data});}catch{res.status(503).json({success:false,error:'Could not load user'});}
});
router.use((req,res,next)=>{
  if(!['super_admin','admin'].includes(req.user?.role))return res.status(403).json({success:false,error:'Administrator access required'});
  next();
});
async function save(req,res,create){
  try{
    const body=req.body||{};
    const existing=create?null:await prisma.user.findUnique({where:{id:req.params.id}});
    if(!create&&!existing)return res.status(404).json({success:false,error:'User not found'});
    if(req.user.role!=='super_admin'&&(body.role==='super_admin'||existing?.role==='super_admin'))return res.status(403).json({success:false,error:'Super admin access required'});
    const data={};
    for(const k of ['name','email','role','phone','avatar','status'])if(body[k]!==undefined)data[k]=body[k];
    if(data.email)data.email=data.email.trim().toLowerCase();
    if(data.role&&!roles.includes(data.role))return res.status(400).json({success:false,error:'Invalid role'});
    if(data.status&&!['active','inactive'].includes(data.status))return res.status(400).json({success:false,error:'Invalid status'});
    if(body.password){
      if(typeof body.password!=='string'||body.password.length<12)return res.status(400).json({success:false,error:'Password must contain at least 12 characters'});
      data.passwordHash=await bcrypt.hash(body.password,12);
    }
    if(create&&(!data.name||!data.email||!data.passwordHash))return res.status(400).json({success:false,error:'Name, email and password required'});
    const user=create?await prisma.user.create({data:{id:randomUUID(),role:'sales_executive',...data},select:fields}):await prisma.user.update({where:{id:req.params.id},data,select:fields});
    res.status(create?201:200).json({success:true,data:user});
  }catch(e){res.status(e.code==='P2002'?409:503).json({success:false,error:e.code==='P2002'?'Email already exists':'Could not save user'});}
}
router.post('/',(req,res)=>save(req,res,true));
router.put('/:id',(req,res)=>save(req,res,false));
router.delete('/:id',async(req,res)=>{
  try{
    if(req.params.id===req.user.id)return res.status(400).json({success:false,error:'You cannot delete your own account'});
    const user=await prisma.user.findUnique({where:{id:req.params.id}});
    if(!user)return res.status(404).json({success:false,error:'User not found'});
    if(user.role==='super_admin'&&req.user.role!=='super_admin')return res.status(403).json({success:false,error:'Super admin access required'});
    await prisma.user.update({where:{id:user.id},data:{status:'inactive'}});
    res.json({success:true,message:'Account deactivated; business records retained'});
  }catch{res.status(503).json({success:false,error:'Could not deactivate account'});}
});
module.exports=router;
