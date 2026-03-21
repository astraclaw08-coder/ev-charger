const {PrismaClient}=require('../node_modules/.prisma/client');
const p=new PrismaClient();
(async()=>{
  const users=await p.user.findMany({
    where:{
      OR:[
        {email:{contains:'sdang3209',mode:'insensitive'}},
        {name:{contains:'sdang3209',mode:'insensitive'}},
        {clerkId:{contains:'sdang3209',mode:'insensitive'}}
      ]
    },
    select:{id:true,email:true,name:true,clerkId:true,idTag:true,createdAt:true}
  });
  console.log(JSON.stringify(users,null,2));
  await p.$disconnect();
})().catch(async e=>{console.error(e);await p.$disconnect();process.exit(1);});
