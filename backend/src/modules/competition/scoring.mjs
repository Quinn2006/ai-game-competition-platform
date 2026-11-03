// Exact rational arithmetic: decimals are parsed once; rounding is display-only.
const gcd = (a,b) => b ? gcd(b,a%b) : a;
function ratio(n,d=1n) {
  if(d<=0n) throw new RangeError('Positive denominator required');
  const g=gcd(n<0n?-n:n,d);return {n:n/g,d:d/g};
}
const add=(a,b)=>ratio(a.n*b.d+b.n*a.d,a.d*b.d);
const multiply=(a,n,d=1n)=>ratio(a.n*n,a.d*d);
export function decimal(value) {
  const s=String(value);
  if(!/^(0|[1-9]\d*)(\.\d{1,12})?$/.test(s))throw new RangeError('Nonnegative decimal with at most 12 decimal places required');
  const [whole,fraction='']=s.split('.');
  const r=ratio(BigInt(whole+fraction),10n**BigInt(fraction.length));
  if(r.n>100n*r.d)throw new RangeError('Score exceeds 100');return r;
}
function count(value){
  if(typeof value==='number'&&!Number.isSafeInteger(value))throw new RangeError('Unsafe count');
  if(!/^(0|[1-9]\d*)$/.test(String(value)))throw new RangeError('Nonnegative integer count required');return BigInt(value);
}
export function compare(a,b){const delta=a.n*b.d-b.n*a.d;return delta<0n?-1:delta>0n?1:0;}
export function judgeScore(values){
  if(!Array.isArray(values)||values.length!==5)throw new RangeError('Five criteria required');
  return values.reduce((sum,v,i)=>add(sum,multiply(decimal(v),[25n,25n,20n,15n,15n][i],100n)),ratio(0n));
}
export function judgeAverage(judges){
  if(!Array.isArray(judges)||judges.length<3)throw new RangeError('At least three valid judges required');
  return multiply(judges.reduce((s,j)=>add(s,judgeScore(j)),ratio(0n)),1n,BigInt(judges.length));
}
export function popularity(likes,plays,maxLikes,maxPlays){
  const [l,p,ml,mp]=[likes,plays,maxLikes,maxPlays].map(count);
  if(l>ml||p>mp)throw new RangeError('Inconsistent snapshot maximum');
  return add(ml?ratio(60n*l,ml):ratio(0n),mp?ratio(40n*p,mp):ratio(0n));
}
export const finalScore=(average,popular)=>add(multiply(average,60n,100n),multiply(popular,40n,100n));
export function display(score){
  const cents=(score.n*200n+score.d)/(2n*score.d);
  return `${cents/100n}.${String(cents%100n).padStart(2,'0')}`;
}
export const serialize=r=>({numerator:String(r.n),denominator:String(r.d),display:display(r)});
export function rank(items){
  const order=(a,b)=>compare(b.total,a.total)||compare(b.average,a.average)||
    (count(a.likes)<count(b.likes)?1:count(a.likes)>count(b.likes)?-1:0)||
    (count(a.plays)<count(b.plays)?1:count(a.plays)>count(b.plays)?-1:0);
  const sorted=[...items].sort((a,b)=>order(a,b)||String(a.id).localeCompare(String(b.id)));
  let position=0;return sorted.map((r,i)=>{if(!i||order(r,sorted[i-1]))position=i+1;return {...r,rank:position};});
}
