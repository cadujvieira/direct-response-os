const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeFunnelEvent, eventFingerprint, registerFunnelRoutes } = require("./funnelIntegration");
const { normalizeTracking, sameEvent, ingestTracking } = require("./trackingIngestion");
const now = new Date("2026-10-01T23:30:00Z");
const front = overrides => ({ event_name:"purchase", order_id:"front-1", event_id:"delivery-1",
  click_id:"click-1", email:"Buyer@Example.test", value:297, currency:"BRL",
  payment_status:"approved", occurred_at:"2026-08-02T12:00:00-03:00", ...overrides });
test("compra front normaliza valor, identidade e horario real em UTC", () => {
  const event=normalizeFunnelEvent(front({value:"297.00",telefone:"+55 (44) 99999-9999"}),now);
  assert.equal(event.event_id,"purchase_front-1");
  assert.equal(event.front_order_id,"front-1");
  assert.equal(event.email,"buyer@example.test");
  assert.equal(event.telefone,"5544999999999");
  assert.equal(event.occurred_at,"2026-08-02T15:00:00.000Z");
});
test("novos IDs de entrega de pagamento nao criam nova venda", () => {
  const first=normalizeFunnelEvent(front(),now),retry=normalizeFunnelEvent(front({event_id:"delivery-2"}),now);
  assert.equal(first.event_id,retry.event_id);
  assert.equal(eventFingerprint(first),eventFingerprint(retry));
});
test("mentoria usa chave de pedido distinta e exige referencia front", () => {
  const input=front({event_name:"mentorship_purchase",order_id:"mentor-1",front_order_id:"front-1",click_id:null,value:5000});
  const first=normalizeFunnelEvent(input,now),retry=normalizeFunnelEvent({...input,event_id:"new-delivery"},now);
  assert.equal(first.event_id,retry.event_id);
  assert.notEqual(first.event_id,normalizeFunnelEvent(front(),now).event_id);
  assert.throws(()=>normalizeFunnelEvent({...input,front_order_id:null},now));
});
test("calls tem IDs estaveis separados por etapa e nao registram receita", () => {
  const base={event_name:"call_booked",event_id:"call-1",front_order_id:"front-1",occurred_at:"2026-08-03T15:00:00Z"};
  assert.notEqual(normalizeFunnelEvent(base,now).event_id,normalizeFunnelEvent({...base,event_name:"call_attended"},now).event_id);
  assert.throws(()=>normalizeFunnelEvent({...base,value:5000},now));
  assert.throws(()=>normalizeFunnelEvent({...base,event_id:null},now));
});
test("refunds exigem ID de reembolso, valor e confirmacao distintos de solicitacao", () => {
  const base={event_name:"refund",event_id:"refund-1",order_id:"front-1",value:100,currency:"BRL",payment_status:"refunded",occurred_at:"2026-08-03T15:00:00Z"};
  const first=normalizeFunnelEvent(base,now);
  assert.notEqual(first.event_id,normalizeFunnelEvent({...base,event_id:"refund-2"},now).event_id);
  assert.throws(()=>normalizeFunnelEvent({...base,payment_status:"requested"},now));
  assert.throws(()=>normalizeFunnelEvent({...base,value:-100},now));
});
test("contrato rejeita pagamentos pendentes, moeda indefinida e campos com segredos", () => {
  for(const change of [{payment_status:"pending"},{payment_status:"refunded"},{currency:null},{currency:"USD"},
    {token:"private"},{lead_id:1},{value:0},{value:NaN},{value:297.001},{value:10000001},
    {email:"invalid",telefone:null},{click_id:null},{front_order_id:"other-front"}]) {
    assert.throws(()=>normalizeFunnelEvent(front(change),now));
  }
});
test("datas nao normalizam dias impossiveis e respeitam o fuso e tolerancia de relogio", () => {
  for(const date of ["2026-02-30T12:00:00Z","2026-08-02T12:00:00","2026-08-02T12:65:00Z","2026-10-02T00:00:00Z"]) {
    assert.throws(()=>normalizeFunnelEvent(front({occurred_at:date}),now));
  }
  assert.equal(normalizeFunnelEvent(front({occurred_at:"2026-10-01T20:32:00-03:00"}),now).occurred_at,"2026-10-01T23:32:00.000Z");
});
test("checkout iniciado identifica click, tem chave estavel e nao cria pedido pago", () => {
  const event=normalizeFunnelEvent({event_name:"checkout_started",event_id:"checkout-1",click_id:"click-1",occurred_at:"2026-08-02T14:00:00Z"},now);
  assert.equal(event.value,0);assert.equal(event.order_id,null);
  assert.throws(()=>normalizeFunnelEvent({...event,order_id:"unpaid"},now));
});
test("mudanca de valor, origem ou horario altera a identidade financeira do evento", () => {
  const first=normalizeFunnelEvent(front(),now);
  for(const change of [{value:298},{click_id:"other"},{occurred_at:"2026-08-02T16:00:00Z"}]) {
    assert.notEqual(eventFingerprint(first),eventFingerprint(normalizeFunnelEvent(front(change),now)));
  }
});
test("rotas antigas preservam IDs de compra e aceitam valor numerico textual valido", () => {
  const event=normalizeTracking({order_id:"front-1",valor:"297.00",email:"BUYER@example.test"},true);
  assert.equal(event.event_id,"purchase_front-1");assert.equal(event.value,297);
  for(const valor of [-297,"invalid",Infinity,297.001])assert.throws(()=>normalizeTracking({order_id:"x",valor},true));
});
test("replay nao pode mudar valor, moeda ou click de um evento existente", () => {
  const event=normalizeTracking({event_name:"purchase",event_id:"x",value:297,click_id:"c"});
  const stored={...event,created_at:new Date()};
  assert.equal(sameEvent(stored,event),true);
  for(const change of [{value:298},{currency:"USD"},{click_id:"d"}])assert.equal(sameEvent(stored,{...event,...change}),false);
});
test("falha na fila aborta evento e CRM na mesma transacao e libera conexao", async () => {
  const calls=[];
  const event=normalizeTracking({event_name:"call_booked",event_id:"x",click_id:"c"});
  const client={query:async(sql)=>{calls.push(sql);return {rows:sql.includes("INSERT INTO dr_events")?[{...event,id:1,created_at:new Date()}]:[]};},release:()=>calls.push("RELEASE")};
  await assert.rejects(ingestTracking({connect:async()=>client},event,{syncLeadCrmFromEvent:async(_,__,options)=>{
    assert.equal(options.client,client);calls.push("CRM");
  },enqueueAutomationEvent:async()=>{calls.push("QUEUE");throw Error("queue unavailable");}}),/queue unavailable/);
  assert.ok(calls.includes("ROLLBACK"));assert.ok(!calls.includes("COMMIT"));assert.equal(calls.at(-1),"RELEASE");
});
test("integracao protegida rejeita leitura e escrita antes de consultar banco", async () => {
  const routes=new Map(),previous=process.env.DR_ADMIN_SECRET;
  process.env.DR_ADMIN_SECRET="funnel-test-secret";
  registerFunnelRoutes({get:(path,fn)=>routes.set(path,fn),post:(path,fn)=>routes.set(path,fn)},
    {query:async()=>assert.fail("unauthorized query"),connect:async()=>assert.fail("unauthorized connection")},{});
  try {
    for(const path of ["/api/integrations/funnel/status","/api/integrations/funnel/events"]){
      let status;await routes.get(path)({get:()=>""},{status:code=>({json:()=>{status=code;}})});assert.equal(status,401);
    }
  }finally{if(previous==null)delete process.env.DR_ADMIN_SECRET;else process.env.DR_ADMIN_SECRET=previous;}
});
