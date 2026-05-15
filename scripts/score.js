// scripts/score.js
(() => {
  const storeKey = 'tangohop-highscore';
  let score = 0, high = +localStorage.getItem(storeKey) || 0;

  const el = document.createElement('div');
  el.id = "score";
  el.style.cssText = "font:14px/1.2 system-ui, sans-serif;";
  document.body.appendChild(el);

  function render(){ el.textContent = `Score: ${score}   High: ${high}`; }
  render();

  window.scoreHook = {
    add(n){ score += (n|0); render(); },
    reset(){ score = 0; render(); },
    win(){ score += 100; if (score>high) { high = score; localStorage.setItem(storeKey, high);} render(); },
    lose(){ score = Math.max(0, score-50); render(); }
  };
})();
