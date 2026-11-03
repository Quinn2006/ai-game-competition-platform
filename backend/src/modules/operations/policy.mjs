import { AppError } from '../../platform/errors.mjs';
export const fail=(code,status=400,message='请检查输入及操作权限')=>{throw new AppError(code,status,message);};
export const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
export function textField(v,max){if(typeof v!=='string'||!v.trim()||[...v].length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v))fail('INVALID_TEXT');return v.trim();}
export function dateRange(input={}){
 const today=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
 for(const k of ['from','to'])if(input[k]&&(!/^\d{4}-\d{2}-\d{2}$/.test(input[k])||!Number.isFinite(+new Date(input[k]))||new Date(input[k]).toISOString().slice(0,10)!==input[k]))fail('INVALID_DATE');
 const end=new Date((input.to||today)+'T00:00:00+08:00');end.setTime(+end+86400000);
 const start=input.from?new Date(input.from+'T00:00:00+08:00'):new Date(+end-30*86400000);
 if(!Number.isFinite(+start)||!Number.isFinite(+end)||end<=start||end-start>366*86400000)fail('INVALID_DATE');
 return [start,end];
}
export function csv(rows,columns){
 const cell=v=>'"'+String(v??'').replace(/^[\s]*[=+@-]/,m=>"'"+m).replaceAll('"','""')+'"';
 return '\ufeff'+[columns,...rows.map(r=>columns.map(k=>r[k]))].map(r=>r.map(cell).join(',')).join('\r\n');
}
// Excel 2003 XML is a native Excel workbook format, with explicit String cells.
export function excelXml(rows,columns){
 const escape=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'');
 return '<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="运营报表"><Table>'+[columns,...rows.map(r=>columns.map(k=>r[k]))].map(r=>'<Row>'+r.map(v=>'<Cell><Data ss:Type="String">'+escape(v)+'</Data></Cell>').join('')+'</Row>').join('')+'</Table></Worksheet></Workbook>';
}
