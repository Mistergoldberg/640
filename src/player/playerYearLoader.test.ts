import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Catalog } from '../types';
import { PlayerYearLoader } from './playerYearLoader';

const catalog: Catalog = JSON.parse(fs.readFileSync('public/data/catalog.json','utf8'));
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
function setup() {
  vi.stubGlobal('Image', class { src=''; decoding=''; onload=null; onerror=null; decode(){return Promise.resolve();} removeAttribute(){this.src='';} });
  const fetchMock=vi.fn(async(url:string)=>new Response(fs.readFileSync(path.resolve('public',url.replace(/^\//,'')),'utf8'),{status:200}));
  vi.stubGlobal('fetch',fetchMock);return fetchMock;
}
describe('bounded player year loader',()=>{
 it('deduplicates loads and retains only the current year and adjacent years',async()=>{
  const fetchMock=setup();const loader=new PlayerYearLoader(catalog);
  try {
   const first=loader.load(loader.years[0]);expect(loader.load(loader.years[0])).toBe(first);
   const loaded=await first;expect(loaded.photos.length).toBeGreaterThan(0);
   const count=fetchMock.mock.calls.length;await loader.load(loader.years[0]);expect(fetchMock.mock.calls.length).toBe(count);
   for(const year of loader.years.slice(1,5)){await loader.load(year);loader.retain(year);expect(loader.size).toBeLessThanOrEqual(3);}
   expect(loader.adjacent(loader.years.at(-1)!,1)).toBeNull();
  }finally{loader.dispose();expect(loader.size).toBe(0);}
 });
 it('retains a failed request until deliberate retry, instead of retrying on every frame',async()=>{
  const fetchMock=setup();fetchMock.mockResolvedValueOnce(new Response('unavailable',{status:503}));
  const loader=new PlayerYearLoader(catalog);const year=loader.years[0];
  await expect(loader.load(year)).rejects.toThrow();const count=fetchMock.mock.calls.length;
  await expect(loader.load(year)).rejects.toThrow();expect(fetchMock.mock.calls.length).toBe(count);
  loader.remove(year);await expect(loader.load(year)).resolves.toMatchObject({year});loader.dispose();
 });
 it('times out a stalled request so the boundary can offer retry',async()=>{
  vi.useFakeTimers();setup();
  vi.stubGlobal('fetch',vi.fn((_url:string,{signal}:{signal:AbortSignal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError'))))));
  const loader=new PlayerYearLoader(catalog);const promise=loader.load(loader.years[0]);
  const rejected=expect(promise).rejects.toThrow('Cancelled');
  await vi.advanceTimersByTimeAsync(30_000);await rejected;loader.dispose();
 });
 it('aborts in-flight requests on disposal' ,async()=>{
  setup();let aborted=false;
  vi.stubGlobal('fetch',vi.fn((_url:string,{signal}:{signal:AbortSignal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new DOMException('Cancelled','AbortError'));}))));
  const loader=new PlayerYearLoader(catalog);const promise=loader.load(loader.years[0]);loader.dispose();
  await expect(promise).rejects.toThrow('Cancelled');expect(aborted).toBe(true);expect(loader.size).toBe(0);
 });
});
