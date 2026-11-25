const f = document.getElementById('f');
const err = document.getElementById('err');
f.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.textContent = '';
  const btn = f.querySelector('button');
  btn.disabled = true;
  try {
    const r = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: document.getElementById('pw').value }),
    });
    if (r.ok) return location.reload();
    err.textContent = (await r.json().catch(() => ({}))).error || 'Login failed';
  } catch {
    err.textContent = 'Network error';
  }
  btn.disabled = false;
});
