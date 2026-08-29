// @ts-check
import {store} from '../state/store.js';
import {calendars,rpc} from '../services/access.js';
import {listPendingBookingRequests,getCalendarNotificationMinutes,setCalendarNotificationMinutes} from '../services/businesses.js';
import {escapeHtml} from '../ui/dom.js';
import {page,bindBack,toast} from '../ui/layout.js';

export async function notificationsScreen(root,role){
  if(role!=='business'){root.innerHTML=page({title:'Notificări',nav:'customer',content:''});bindBack(root);return;}
  const business=store.get().business;const params=new URLSearchParams(window.location.hash.split('?')[1]||'');const selected=params.get('calendar')||'';
  const [requests,list]=await Promise.all([listPendingBookingRequests(business.id),calendars(business.id)]);
  const minutes=selected?await getCalendarNotificationMinutes(selected):15;
  root.innerHTML=page({title:'Notificări',nav:'business',active:'notifications',content:`<section class="draw-section"><div class="request-list">${requests.map(item=>`<article><span><strong>${escapeHtml(item.customer)}</strong><small>${escapeHtml(item.service)} · ${escapeHtml(item.time)}-${escapeHtml(item.endTime)}</small></span><span><button data-request="${escapeHtml(item.id)}" data-status="confirmed">Approve</button><button data-request="${escapeHtml(item.id)}" data-status="rejected">Reject</button></span></article>`).join('')}</div></section><section class="draw-section"><label>Selector calendar<select id="notification-calendar"><option value=""></option>${list.map(item=>`<option value="${escapeHtml(item.id)}" ${item.id===selected?'selected':''}>${escapeHtml(item.name)}</option>`).join('')}</select></label></section>${selected?`<section class="draw-section draw-section--center"><h1>Calendar &lt;${escapeHtml(list.find(item=>item.id===selected)?.name||'')}&gt;</h1><form id="calendar-reminder"><label>Notificare cu <input name="minutes" type="number" min="2" max="30" value="${minutes}" required> min. înainte de programare</label><button class="draw-button">Gata</button></form></section>`:''}`});
  bindBack(root);root.querySelector('#notification-calendar')?.addEventListener('change',event=>{window.location.hash=`/business/notifications?calendar=${/** @type {HTMLSelectElement} */(event.currentTarget).value}`;});
  root.querySelectorAll('[data-request]').forEach(button=>button.addEventListener('click',async()=>{try{await rpc('set_booking_status',{p_booking_id:button.getAttribute('data-request'),p_status:button.getAttribute('data-status')});await notificationsScreen(root,'business');}catch(error){toast(root,error.message,'error');}}));
  root.querySelector('#calendar-reminder')?.addEventListener('submit',async event=>{event.preventDefault();try{await setCalendarNotificationMinutes(selected,Number(new FormData(/** @type {HTMLFormElement} */(event.currentTarget)).get('minutes')));await notificationsScreen(root,'business');}catch(error){toast(root,error.message,'error');}});
}
