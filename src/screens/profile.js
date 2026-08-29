// @ts-check
import {config} from '../config.js';
import {navigate} from '../router.js';
import {signOut} from '../services/auth.js';
import {store} from '../state/store.js';
import {escapeHtml} from '../ui/dom.js';
import {bindBack,page} from '../ui/layout.js';

export function profileScreen(root){
  const state=store.get();const business=state.role==='business';
  root.innerHTML=page({title:'Contul meu',nav:business?'business':'customer',active:'profile',content:`<section class="draw-section draw-section--center"><h1>${business?'Email':'Email'}</h1><strong class="account-email">${escapeHtml(state.user?.email||'')}</strong></section>${business?`<section class="draw-section draw-section--center"><h1>Gestiune abonament</h1><div class="plan-buttons"><button data-account-plan="small">Small</button><button data-account-plan="large">Complete</button></div></section>`:''}<section class="draw-section draw-section--center"><h1>Termeni și condiții</h1><a href="${config.links.terms}" target="_blank" rel="noreferrer">Terms</a><a href="${config.links.privacy}" target="_blank" rel="noreferrer">Privacy policy</a></section><section class="draw-section draw-section--center"><button class="draw-button" id="sign-out">Sign out</button></section>`});
  bindBack(root);root.querySelectorAll('[data-account-plan]').forEach(button=>button.addEventListener('click',async()=>{await store.set({selectedPlan:button.getAttribute('data-account-plan')});navigate('/business/payment');}));root.querySelector('#sign-out')?.addEventListener('click',async()=>{await signOut();navigate('/');});
}
