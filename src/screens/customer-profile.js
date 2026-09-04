// @ts-check
import { completeCustomerProfile } from '../services/customer-profile.js';
import { navigate } from '../router.js';
import { signOut } from '../services/auth.js';
import { bindBack, loadingButton, page, toast } from '../ui/layout.js';
import { errorMessageForUser } from '../ui/error-message.js';
import { formData } from '../ui/dom.js';

export function customerProfileSetupScreen(root) {
  root.innerHTML = page({
    eyebrow: 'PROFIL CLIENT', title: 'Cum te numești?',
    content: `<section class="section-heading"><h1>Completează profilul</h1><p>Numele este cerut o singură dată și va apărea pe cererile tale de programare.</p></section>
      <form class="form-card" id="customer-profile-form">
        <label>Prenume<input name="firstName" required minlength="2" maxlength="50" autocomplete="given-name"></label>
        <label>Nume<input name="lastName" required minlength="2" maxlength="50" autocomplete="family-name"></label>
        <button class="button button--primary" type="submit">Salvează și continuă</button>
      </form>
      <button class="text-button" id="customer-setup-sign-out">Deconectare</button>`,
  });
  bindBack(root);
  root.querySelector('#customer-setup-sign-out')?.addEventListener('click', async () => { await signOut(); navigate('/'); });
  root.querySelector('#customer-profile-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = /** @type {HTMLFormElement} */ (event.currentTarget);
    const button = /** @type {HTMLButtonElement} */ (form.querySelector('button'));
    const values = formData(form);
    try {
      loadingButton(button, true, 'Se salvează…');
      await completeCustomerProfile(values.firstName, values.lastName);
      navigate('/customer/search');
    } catch (error) {
      loadingButton(button, false);
      toast(root, errorMessageForUser(error), 'error');
    }
  });
}
