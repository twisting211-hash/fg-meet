(function () {
  const root = document.documentElement;
  const saved = localStorage.getItem('fgcall-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (saved) root.setAttribute('data-theme', saved);
  else if (prefersDark) root.setAttribute('data-theme', 'dark');

  document.getElementById('themeToggle').addEventListener('click', () => {
    const cur = root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    const next = cur === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    localStorage.setItem('fgcall-theme', next);
  });

  const errorMsg = document.getElementById('errorMsg');
  const roomInput = document.getElementById('roomInput');

  document.getElementById('createBtn').addEventListener('click', async () => {
    errorMsg.textContent = '';
    try {
      const res = await fetch('/api/new-room');
      const data = await res.json();
      window.location.href = '/call/' + data.room_id;
    } catch (e) {
      errorMsg.textContent = 'Could not create room. Try again.';
    }
  });

  document.getElementById('joinBtn').addEventListener('click', () => {
    const val = roomInput.value.trim();
    if (!/^[A-Za-z0-9\-]{4,32}$/.test(val)) {
      errorMsg.textContent = 'Enter a valid room ID (4-32 letters/numbers).';
      return;
    }
    window.location.href = '/call/' + val;
  });

  roomInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('joinBtn').click();
  });
})();
