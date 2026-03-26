const {PrismaClient}=require('../node_modules/.prisma/client');
const p=new PrismaClient();
(async()=>{
  const c=await p.charger.findUnique({where:{ocppId:'CP001'},include:{site:true,connectors:true}});
  console.log(JSON.stringify(c,null,2));
  await p.$disconnect();
})().catch(async (e)=>{console.error(e);await p.$disconnect();process.exit(1);});
