// @ts-check
import {demoBusinesses} from '../data.js';
import {navigate} from '../router.js';
import {availableServiceSlots,createBooking,listCustomerBookings} from '../services/bookings.js';
import {getBusiness,listBusinesses} from '../services/businesses.js';
import {store} from '../state/store.js';
import {escapeHtml} from '../ui/dom.js';
import {icon} from '../ui/icons.js';
import {bindBack,page,toast,loadingButton} from '../ui/layout.js';

export async function customerSearchScreen(root){
  const businesses=await listBusinesses();
  root.innerHTML=page({title:'Home',nav:'customer',active:'search',content:`<section class="draw-section"><label class="draw-search"><input id="company-search" placeholder="Caută afacere">${icon('search')}</label><div id="business-list" class="draw-list">${businessRows(businesses)}</div></section>`});
  bindBack(root);root.querySelector('#company-search')?.addEventListener('input',async event=>{const query=/** @type {HTMLInputElement} */(event.currentTarget).value.trim().toLocaleLowerCase('ro');const filtered=businesses.filter(item=>item.name.toLocaleLowerCase('ro').startsWith(query));const list=root.querySelector('#business-list');if(list)list.innerHTML=businessRows(filtered);bindBusinesses(root);});bindBusinesses(root);
}

function businessRows(items){return items.map(item=>`<button class="draw-list-row" data-company="${escapeHtml(item.id)}"><span>${escapeHtml(item.name)}</span>${icon('arrow')}</button>`).join('');}
function bindBusinesses(root){root.querySelectorAll('[data-company]').forEach(button=>button.addEventListener('click',async()=>{await store.set({selectedBusinessId:button.getAttribute('data-company')});navigate('/customer/company');}));}

export async function companyScreen(root){
  const id=store.get().selectedBusinessId||demoBusinesses[0].id;const business=await getBusiness(id);const services=business.services||[];
  root.innerHTML=page({title:'Fă programare',nav:'customer',content:`<form class="draw-form" id="booking-request"><label>Alege serviciu<select name="service" id="service-select"><option value=""></option>${services.map(item=>`<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('')}</select></label><label>Ore disponibile<select name="slot" id="slot-select" disabled></select></label><label>Durata<input id="service-duration" readonly> minute</label><button class="draw-button" disabled>Solicită</button></form>`});
  bindBack(root);const serviceSelect=/** @type {HTMLSelectElement|null} */(root.querySelector('#service-select'));const slotSelect=/** @type {HTMLSelectElement|null} */(root.querySelector('#slot-select'));const duration=/** @type {HTMLInputElement|null} */(root.querySelector('#service-duration'));const submit=/** @type {HTMLButtonElement|null} */(root.querySelector('#booking-request button'));
  serviceSelect?.addEventListener('change',async()=>{const service=services.find(item=>item.id===serviceSelect.value);if(!service||!slotSelect||!duration||!submit)return;duration.value=String(service.duration);slotSelect.disabled=true;submit.disabled=true;slotSelect.innerHTML='';try{const slots=await availableServiceSlots(business.id,service.resourceId,service.id);slotSelect.innerHTML=slots.map(item=>`<option value="${escapeHtml(item.start_at)}">${slotLabel(item.start_at)}</option>`).join('');slotSelect.disabled=!slots.length;submit.disabled=!slots.length;}catch(error){toast(root,error.message,'error');}});
  root.querySelector('#booking-request')?.addEventListener('submit',async event=>{event.preventDefault();const form=/** @type {HTMLFormElement} */(event.currentTarget);const service=services.find(item=>item.id===String(new FormData(form).get('service')));if(!service)return;const button=/** @type {HTMLButtonElement} */(form.querySelector('button'));try{loadingButton(button,true);await createBooking({businessId:business.id,eventTypeId:service.id,resourceId:service.resourceId,startAt:String(new FormData(form).get('slot')),customerName:store.get().user?.name||'',reminderMinutes:60});navigate('/customer/bookings');}catch(error){loadingButton(button,false);toast(root,error.message,'error');}});
}

export async function bookingScreen(root){return companyScreen(root);}
export function bookingSuccessScreen(_root){navigate('/customer/bookings');}

export async function customerBookingsScreen(root){
  const bookings=await listCustomerBookings();
  root.innerHTML=page({title:'Progr. mele',nav:'customer',active:'bookings',content:`<section class="draw-section"><div class="draw-list">${bookings.map(item=>`<article class="customer-booking"><span><strong>${escapeHtml(item.business)}</strong><b>${escapeHtml(item.service)}</b><small>${escapeHtml(item.time)}, ${durationLabel(item.duration)}, ${formatDate(item.date)}</small></span><button data-booking-qr="${escapeHtml(item.id)}" aria-label="QR programare">${icon('qr')}</button></article>`).join('')}</div></section>`});
  bindBack(root);root.querySelectorAll('[data-booking-qr]').forEach(button=>button.addEventListener('click',async()=>{await store.set({selectedBookingId:button.getAttribute('data-booking-qr')});navigate('/customer/booking-qr');}));
}

function slotLabel(value){return new Intl.DateTimeFormat('ro-RO',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'Europe/Bucharest'}).format(new Date(value));}
function formatDate(value){return new Intl.DateTimeFormat('ro-RO',{day:'2-digit',month:'2-digit',year:'numeric'}).format(new Date(`${value}T12:00:00`));}
function durationLabel(minutes){return minutes>=60&&minutes%60===0?`${minutes/60} ${minutes===60?'oră':'ore'}`:`${minutes} minute`;}
