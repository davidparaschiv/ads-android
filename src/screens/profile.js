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
import {errorMessageForUser} from '../ui/error-message.js';
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
  const accountName=business?(state.business?.name||state.user?.name||'Afacerea mea'):(state.user?.name||'Client Rezervări AI');
  const accountType=business?'Cont business':'Cont client';
  const accountDetail=business?(access?.active?(access.planId==='large'?'Complete':'Small'):'Plan inactiv'):'Profil activ';
  const accountHero=`<section class="account-modern account-modern--${business?'business':'customer'}" aria-label="Rezumat cont">
    <span class="account-modern__line account-modern__line--top" aria-hidden="true"></span>
    <span class="account-modern__line account-modern__line--bottom" aria-hidden="true"></span>
    <div class="account-modern__identity">
      <span class="account-modern__avatar">${escapeHtml(accountName.trim().slice(0,1).toUpperCase()||'R')}</span>
      <div><small>${accountType}</small><h1>${escapeHtml(accountName)}</h1><p>${escapeHtml(state.user?.email||'')}</p></div>
    </div>
    <div class="account-modern__tiles">
      <div class="account-modern__tile"><small>TIP CONT</small><strong>${business?'Business':'Client'}</strong></div>
      <div class="account-modern__tile"><small>${business?'ACCES':'STATUS'}</small><strong>${escapeHtml(accountDetail)}</strong></div>
    </div>
  </section>`;
  const businessAccess=licenseActive
    ? `<section class="draw-section account-glass-card"><div class="section-heading"><h1>Licență</h1><p>${escapeHtml(expiry==='fără expirare'?`Licență activă · ${expiry}.`:`Licență activă până la ${expiry}.`)}</p></div>${ownerAction?`<div class="stack">${ownerAction}</div>`:''}</section>`
    : `<section class="draw-section account-glass-card"><div class="section-heading"><h1>Gestiune abonament</h1><p>${escapeHtml(accessStatus)}</p></div><div class="plan-grid">${planCard('small',selected)}${planCard('large',selected)}</div><div class="stack"><button class="button button--secondary" id="restore-purchases">Restaurează achizițiile</button>${billing?.managementURL?'<button class="button button--secondary" id="manage-subscription">Gestionează sau anulează în Google Play</button>':''}${ownerAction}</div></section>`;
  root.innerHTML=page({title:'Contul meu',nav:business?'business':'customer',active:'profile',content:`${accountHero}${business?businessAccess:''}<section class="draw-section draw-section--center account-glass-card account-legal-card"><span class="account-card-kicker">DOCUMENTE</span><h1>Siguranță și transparență</h1><div class="account-link-list"><a href="${config.links.terms}" target="_blank" rel="noreferrer"><span>Termeni și condiții</span><b aria-hidden="true">›</b></a><a href="${config.links.privacy}" target="_blank" rel="noreferrer"><span>Politica de confidențialitate</span><b aria-hidden="true">›</b></a></div></section><section class="draw-section draw-section--center account-glass-card account-signout-card"><button class="button button--secondary" id="sign-out">Deconectare</button></section>`});
  bindBack(root);
  root.querySelectorAll('[data-plan]').forEach(button=>button.addEventListener('click',async()=>{const plan=button.getAttribute('data-plan');if(plan===selected&&access?.active)return;if(access?.active&&selected==='large'&&plan==='small'){toast(root,'Trecerea de la Complete la Small nu este disponibilă.','error');return;}await store.set({selectedPlan:plan});navigate('/business/payment');}));
  root.querySelector('#restore-purchases')?.addEventListener('click',async event=>{const button=event.currentTarget;try{loadingButton(button,true);const result=await restorePurchases();if(!result.active)throw new Error('Nu am găsit un abonament activ.');toast(root,'Achizițiile au fost restaurate.');await profileScreen(root);}catch(error){loadingButton(button,false);toast(root,errorMessageForUser(error),'error');}});
  root.querySelector('#manage-subscription')?.addEventListener('click',async event=>{const button=event.currentTarget;try{loadingButton(button,true,'Se deschide Google Play…');await openSubscriptionManagement(state.user?.id||'');}catch(error){toast(root,errorMessageForUser(error),'error');}finally{loadingButton(button,false);}});
  root.querySelector('#sign-out')?.addEventListener('click',async()=>{await signOut();navigate('/');});
}
