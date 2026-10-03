export const rentalStatus=(value:string,lang:string)=>({
  pending:["Ожидает проверки или запуска","Pending review or start"],approved:["Подтверждён","Approved"],suspended:["Приостановлен","Suspended"],
  starting:["Запускается","Starting"],running:["Работает","Running"],stopped:["Остановлен","Stopped"],released:["Завершение и очистка","Release and cleanup"],
  error:["Ошибка узла","Node error"],succeeded:["Выполнено","Completed"],failed:["Ошибка","Failed"],cancelled:["Отменено","Cancelled"],
} as Record<string,string[]>)[value]?.[lang==="ru"?0:1]??value;
