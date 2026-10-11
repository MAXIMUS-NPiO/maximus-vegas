export function errorRecovery(path:string,error:{digest?:string;message?:string}) {
  const ru=path==="/ru"||path.startsWith("/ru/");
  return {home:ru?"/ru":"/en",lang:ru?"ru":"en",title:ru?"Не удалось открыть страницу":"This page could not load",
    detail:ru?"Повторите попытку. Перед повторной отправкой результата проверьте его статус.":"Try again. Before resubmitting a result, check whether it was already saved.",
    retry:ru?"Повторить":"Try again",back:ru?"На главную":"Go to home",status:ru?"Статус сервисов":"Service status",
    reference:error.digest&&/^[a-zA-Z0-9_-]{1,80}$/.test(error.digest)?error.digest:null};
}
