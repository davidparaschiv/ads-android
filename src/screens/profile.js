// @ts-check
import {config} from '../config.js';
import {navigate} from '../router.js';
import {signOut} from '../services/auth.js';
import {getAccess} from '../services/access.js';
import {getBillingStatus,openSubscriptionManagement,restorePurchases} from '../services/billing.js';
import {isPlatformOwnerAccount} from '../services/enrollment.js';
import {store} from '../state/store.js';
import {escapeHtml} from '../ui/dom.js';
import {bindBack,loadingButton,page,toast} from '../ui/layout.js';
import {planCard} from './business.js';

function accessExpiryLabel(value){
  if(value===null||value===undefined||value===''||value==='infinity')return 'fără expirare';
  const date=new Date(value);
  return Number.isFinite(date.getTime())?new Intl.DateTimeFormat('ro-RO',{dateStyle:'medium'}).format(date):'fără expirare';
}

export async function profileScreen(root){
  const state=store.get();const business=state.role==='business';
  let access=null,billing=null,platformOwner=false;
  if(business){
    [access,platformOwner]=await Promise.all([getAccess(state.business?.id),isPlatformOwnerAccount()]);
    if(access.source==='google_play') billing=await getBillingStatus(state.user?.id||'').catch(()=>null);
  }
  const selected=access?.planId||billing?.planId||state.selectedPlan||'small';
  const expiry=accessExpiryLabel(access?.expiresAt);
  const licenseActive=access?.active&&['license','developer'].includes(access.source);
  const accessStatus=access?.active?(expiry==='fără expirare'?`Plan activ · ${expiry}.`:`Plan activ până la ${expiry}.`):'Alege un plan pentru a activa accesul afacerii.';
  const ownerAction=platformOwner?'<button class="button button--secondary" data-route="/business/approve">Verificări business</button>':'';
  const businessAccess=licenseActive
    ? `<section class="draw-section"><div class="section-heading"><h1>Licență</h1><p>${escapeHtml(expiry==='fără expirare'?`Licență activă · ${expiry}.`:`Licență activă până la ${expiry}.`)}</p></div>${ownerAction?`<div class="stack">${ownerAction}</div>`:''}</section>`
    : `<section class="draw-section"><div class="section-heading"><h1>Gestiune abonament</h1><p>${escapeHtml(accessStatus)}</p></div><div class="plan-grid">${planCard('small',selected)}${planCard('large',selected)}</div><div class="stack"><button class="button button--secondary" id="restore-purchases">Restaurează achizițiile</button>${billing?.managementURL?'<button class="button button--secondary" id="manage-subscription">Gestionează sau anulează în Google Play</button>':''}${ownerAction}</div></section>`;
  root.innerHTML=page({title:'Contul meu',nav:business?'business':'customer',active:'profile',content:`<section class="draw-section draw-section--center"><h1>E-mail</h1><strong class="account-email">${escapeHtml(state.user?.email||'')}</strong></section>${business?businessAccess:''}<section class="draw-section draw-section--center"><h1>Termeni și condiții</h1><a href="${config.links.terms}" target="_blank" rel="noreferrer">Termeni și condiții</a><a href="${config.links.privacy}" target="_blank" rel="noreferrer">Politica de confidențialitate</a></section><section class="draw-section draw-section--center"><button class="button button--secondary" id="sign-out">Deconectare</button></section>`});
  bindBack(root);
  root.querySelectorAll('[data-plan]').forEach(button=>button.addEventListener('click',async()=>{const plan=button.getAttribute('data-plan');if(plan===selected&&access?.active)return;if(access?.active&&selected==='large'&&plan==='small'){toast(root,'Trecerea de la Complete la Small nu este disponibilă.','error');return;}await store.set({selectedPlan:plan});navigate('/business/payment');}));
  root.querySelector('#restore-purchases')?.addEventListener('click',async event=>{const button=event.currentTarget;try{loadingButton(button,true);const result=await restorePurchases();if(!result.active)throw new Error('Nu am găsit un abonament activ.');toast(root,'Achizițiile au fost restaurate.');await profileScreen(root);}catch(error){loadingButton(button,false);toast(root,error.message||'Restaurarea a eșuat.','error');}});
  root.querySelector('#manage-subscription')?.addEventListener('click',async event=>{const button=event.currentTarget;try{loadingButton(button,true,'Se deschide Google Play…');await openSubscriptionManagement(state.user?.id||'');}catch(error){toast(root,error.message||'Google Play nu poate fi deschis.','error');}finally{loadingButton(button,false);}});
  root.querySelector('#sign-out')?.addEventListener('click',async()=>{await signOut();navigate('/');});
}
