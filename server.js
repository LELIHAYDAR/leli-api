require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const stripe = require('stripe')(process.env.STRIPE_SECRET || '');
const { Queue } = require('bullmq');
const IORedis = require('ioredis');

const prisma = new PrismaClient();
const app = express();
app.use(cors());
app.use(bodyParser.json());

const connection = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
const reminderQueue = new Queue('reminderQueue', { connection });

// health
app.get('/api/health', (req,res)=>res.json({ ok:true }));

app.get('/api/services', async (req,res)=>{ const services = await prisma.service.findMany(); res.json(services); });

// create appointment + optional PaymentIntent
app.post('/api/appointments', async (req,res)=>{
  try{
    const { clientId, staffId, serviceId, startTs, notes, prepay } = req.body;
    if(!clientId||!staffId||!serviceId||!startTs) return res.status(400).json({ error:'Missing fields' });
    const service = await prisma.service.findUnique({ where: { id: serviceId }});
    if(!service) return res.status(404).json({ error:'Service not found' });
    const start = new Date(startTs);
    const end = new Date(start.getTime() + service.durationMin*60000);
    const conflict = await prisma.appointment.findFirst({
      where: {
        staffId,
        status: { in: ['booked','confirmed'] },
        AND: [ { startTs: { lt: end }}, { endTs: { gt: start }} ]
      }
    });
    if(conflict) return res.status(409).json({ error:'Time slot unavailable' });
    let paymentIntent = null;
    if(prepay && process.env.STRIPE_SECRET){
      paymentIntent = await stripe.paymentIntents.create({
        amount: service.priceCents,
        currency: 'usd',
        metadata: { serviceId, clientId }
      });
    }
    const appointment = await prisma.appointment.create({
      data: { clientId, staffId, serviceId, startTs: start, endTs: end, priceCents: service.priceCents, notes }
    });
    // schedule reminders 24h and 2h before
    const reminderTimes = [ new Date(start.getTime() - 24*60*60*1000), new Date(start.getTime() - 2*60*60*1000) ];
    for(const t of reminderTimes) if(t>new Date()){
      await reminderQueue.add('sendReminder', { appointmentId: appointment.id }, { delay: t.getTime() - Date.now() });
    }
    res.json({ appointment, paymentIntent });
  }catch(e){ console.error(e); res.status(500).json({ error:'Server error' }); }
});

app.post('/webhook', bodyParser.raw({ type: 'application/json' }), (req,res)=>{
  const sig = req.headers['stripe-signature'];
  let event;
  try{ event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET); }
  catch(err){ console.log('stripe webhook error', err.message); return res.status(400).send(`Webhook Error: ${err.message}`); }
  if(event.type === 'payment_intent.succeeded'){ console.log('PaymentIntent succeeded', event.data.object.id); }
  res.json({ received: true });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, ()=>console.log('API running on', PORT));
