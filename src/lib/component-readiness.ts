import type {ModuleState} from './directions.ts';
/** Runtime gates are availability signals, never evidence of external live acceptance. */
export function componentReadiness(text:boolean,voice:boolean,studio:boolean){
 return [
 {id:'text-chat',state:(text?'works':'connect') as ModuleState,name:{ru:'Текстовый чат',en:'Text chat'},note:{ru:text?'Доступен: сообщения сохраняются, действуют жалобы и блокировки.':'Недоступен: проверьте базу, флаг сообщества и режим обслуживания.',en:text?'Available: persistent messages, reports and blocks.':'Unavailable: check database, community gate and maintenance.'}},
 {id:'voice',state:'connect' as ModuleState,name:{ru:'Голос',en:'Voice'},note:{ru:voice?'Технические условия выполнены; приёмка на реальных устройствах не подтверждена.':'Отключён: нужны провайдер, разрешение и свежий heartbeat планировщика.',en:voice?'Runtime gates satisfied; real-device live acceptance remains unconfirmed.':'Disabled: provider, enablement and fresh scheduler heartbeat required; live acceptance pending.'}},
 {id:'native-studio',state:'connect' as ModuleState,name:{ru:'Встроенная студия',en:'Native studio'},note:{ru:studio?'Технические условия выполнены; приёмка записи, оплаты и удаления не подтверждена.':'Отключена: нужны провайдер, закрытое хранилище, тариф, оплата и планировщик.',en:studio?'Runtime gates satisfied; recording, payment and deletion live acceptance remains unconfirmed.':'Disabled: provider, private storage, approved tariff, payment and scheduler required; live acceptance pending.'}},
 {id:'pubg',state:'connect' as ModuleState,name:{ru:'Проверка результатов PUBG / CS2',en:'PUBG / CS2 result verification'},note:{ru:'Подготовлено в коде. NOT live-verified. Самостоятельные отчёты проверяет организатор.',en:'Code prepared. NOT live-verified. Self-submitted results require organiser review.'}}
 ];
}
