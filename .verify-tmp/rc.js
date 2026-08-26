const row = document.querySelector('[data-mate-id="mate-1"]');
const r = row.getBoundingClientRect();
row.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, clientX:r.left+20, clientY:r.top+10}));
document.querySelector('[data-action=animate]').click();
const bar = document.querySelector('[data-ref=start]').closest('div');
bar.querySelector('[data-ref=end]').value = '360';
bar.querySelector('[data-ref=steps]').value = '60';
bar.querySelector('[data-ref=title]').textContent + ' start=' + bar.querySelector('[data-ref=start]').value + ' hidden=' + bar.className.includes('hidden')
