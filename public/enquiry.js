(() => {
  const dialog = document.getElementById('enquiry-dialog');
  const form = document.getElementById('enquiry-form');
  const fields = document.getElementById('enquiry-fields');
  const status = document.getElementById('enquiry-status');
  const submit = form.querySelector('[type="submit"]');
  const config = window.SHWAS_FORM || {};
  let widget, token = '', busy = false, scriptPromise, opener;
  const configured = /^https:\/\/[a-z0-9.-]+(?::\d+)?\/?$/i.test(config.apiUrl || '') && !!config.siteKey;
  const message = (text, error = false) => { status.textContent = text; status.classList.toggle('error', error); };
  const update = () => { submit.disabled = busy || !token || !configured; };
  function loadCaptcha() {
    if (window.turnstile) return Promise.resolve();
    if (scriptPromise) return scriptPromise;
    scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      const timer = setTimeout(() => reject(new Error('timeout')), 20000);
      script.onload = () => { clearTimeout(timer); resolve(); };
      script.onerror = () => { clearTimeout(timer); reject(new Error('load')); };
      document.head.append(script);
    }).catch(error => { scriptPromise = undefined; throw error; });
    return scriptPromise;
  }
  async function openForm(event) {
    event.preventDefault(); opener = event.currentTarget;
    if (!dialog.open) dialog.showModal();
    document.body.classList.add('enquiry-open');
    if (!configured) { message('Online enquiries are not available yet. Please email us using the link below.'); return; }
    if (widget !== undefined) return;
    message('Loading security verification…');
    try {
      await loadCaptcha();
      if (widget !== undefined) return;
      widget = window.turnstile.render('#enquiry-captcha', {
        sitekey: config.siteKey, action: 'enquiry', theme: 'light', size: 'flexible',
        callback: value => { token = value; update(); },
        'expired-callback': () => { token = ''; update(); message('Please complete security verification again.'); },
        'error-callback': () => { token = ''; update(); message('Security verification could not load. Please try again or email us.', true); }
      });
      message('');
    } catch { message('Security verification could not load. Check your connection, then reopen the form or email us.', true); }
  }
  document.querySelectorAll('[data-enquiry-open]').forEach(link => link.addEventListener('click', openForm));
  dialog.querySelector('.dialog-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { document.body.classList.remove('enquiry-open'); opener?.focus(); });
  form.addEventListener('input', event => event.target.setCustomValidity?.(''));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !configured || !token) return;
    for (const name of ['name']) {
      if (!form.elements[name].value.trim()) form.elements[name].setCustomValidity('Please fill in this field.');
    }
    const mobile = form.elements.mobile.value.replace(/[\s()-]/g, '');
    if (!/^(?:[6-9]\d{9}|\+[1-9]\d{7,14})$/.test(mobile)) form.elements.mobile.setCustomValidity('Enter a 10-digit Indian mobile number or an international number starting with + and the country code.');
    if (!form.reportValidity()) return;
    const data = Object.fromEntries(new FormData(form));
    data.mobile = mobile; data.consent = form.elements.consent.checked; data.token = token;
    busy = true; fields.disabled = true; update(); message('Sending your enquiry…');
    try {
      const response = await fetch(config.apiUrl.replace(/\/$/, '') + '/api/enquiries', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data), signal: AbortSignal.timeout(90000)
      });
      const result = await response.json();
      if (!response.ok || result.ok !== true) throw new Error(result.message || 'We could not confirm receipt. Please email us before trying again.');
      form.reset(); message('Thank you! Your enquiry has been received. Our team will contact you.'); status.focus();
    } catch (error) {
      message(error.name === 'TypeError' || error.name === 'TimeoutError' ? 'We could not confirm receipt. Your details are still here. Please email us before retrying to avoid a duplicate enquiry.' : error.message, true);
      status.focus();
    } finally {
      busy = false; fields.disabled = false; token = ''; update();
      if (widget !== undefined) window.turnstile.reset(widget);
    }
  });
})();
