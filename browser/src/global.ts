// Script-tag build: sets window.Marram. data-finish on the tag runs finish on load and fires
// marram:finished / marram:error on document.
import * as Marram from './index.ts';

declare global {
  interface Window {
    Marram: typeof Marram;
  }
}

window.Marram = Marram;

const finishUrl = (document.currentScript as HTMLScriptElement | null)?.dataset.finish;

function boot(): void {
  if (finishUrl === undefined || finishUrl === '') return;
  Marram.finish({ url: finishUrl })
    .then((result) => {
      if (result !== null) {
        document.dispatchEvent(new CustomEvent('marram:finished', { detail: result }));
      }
    })
    .catch((error: unknown) => {
      document.dispatchEvent(new CustomEvent('marram:error', { detail: error }));
    });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
