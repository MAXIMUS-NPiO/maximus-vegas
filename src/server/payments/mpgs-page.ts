import { randomBytes } from "node:crypto";

const html = (v: string) => v.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const js = (v: string) => JSON.stringify(v).replace(/</g, "\\u003c");

export function mpgsCheckoutPage(input: { gateway: string; session: string; merchant: string; beneficiary: string; amount: number; lang: "ru" | "en"; cancel: string }) {
  const nonce = randomBytes(24).toString("base64"), ru = input.lang === "ru";
  const gateway = new URL(input.gateway).origin;
  const t = (a: string, b: string) => ru ? a : b;
  const message = t("Платёжную страницу открыть не удалось. Вернитесь к счёту и проверьте статус перед повторной попыткой.", "The payment page could not be opened. Return to your invoice and check its status before retrying.");
  const body = `<!doctype html><html lang="${input.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>MAXIMUS VEGAS · ${t("Оплата", "Payment")}</title>
  <style nonce="${nonce}">body{margin:0;background:#10131b;color:#eef1f8;font:18px/1.6 system-ui,sans-serif}main{max-width:600px;margin:8vh auto;padding:28px}button,a{display:inline-block;padding:14px 20px;border-radius:10px}button{background:#e5c675;color:#10131b;border:0;font:inherit;cursor:pointer}button:disabled{opacity:.5}a{color:#e5c675}p{overflow-wrap:anywhere}#error{color:#ffb6b6}small{color:#c4cad5}</style></head><body><main>
  <p>MAXIMUS VEGAS</p><h1>${t("Защищённая оплата", "Secure payment")}</h1><h2>${(input.amount / 100).toFixed(2)} AED</h2>
  <p>${t("Оплату принимает", "Payment is collected by")} <strong>${html(input.merchant)}</strong> ${t("по внутреннему соглашению в пользу", "under an internal agreement for")} ${html(input.beneficiary)}.</p>
  <p><small>${t("Данные карты вводятся на защищённой странице Mastercard. Портал подтвердит оплату после проверки ответа шлюза.", "Enter your card details on Mastercard’s secure page. The portal confirms payment after checking the gateway’s response.")}</small></p>
  <button id="pay" type="button" disabled>${t("Перейти к оплате", "Continue to payment")}</button><a href="${html(input.cancel)}">${t("Вернуться", "Go back")}</a><p id="error" role="alert"></p><noscript>${t("Для защищённой оплаты нужен JavaScript.", "JavaScript is required for secure payment.")}</noscript>
  <script nonce="${nonce}">function mpgsError(){document.getElementById('error').textContent=${js(message)};document.getElementById('pay').disabled=true;}</script>
  <script nonce="${nonce}" src="${gateway}/static/checkout/checkout.min.js" data-error="mpgsError" data-cancel="${html(input.cancel)}" data-timeout="${html(input.cancel)}"></script>
  <script nonce="${nonce}">try{Checkout.configure({session:{id:${js(input.session)}}});let b=document.getElementById('pay');b.disabled=false;b.addEventListener('click',function(){b.disabled=true;try{Checkout.showPaymentPage();}catch(e){mpgsError();}});}catch(e){mpgsError();}</script></main></body></html>`;
  return { body, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store, private", "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "X-Robots-Tag": "noindex, nofollow",
    "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}' ${gateway}; style-src 'nonce-${nonce}'; connect-src ${gateway}; frame-src ${gateway}; img-src ${gateway} data:; form-action ${gateway}; base-uri 'none'; frame-ancestors 'none'` } };
}
