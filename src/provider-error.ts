/** Shared provider error without loading BookMyShow's native TLS transport. */
export class BmsError extends Error {
 constructor(readonly kind:'network'|'blocked'|'unparseable'|'bad_url'|'not_found',message:string){super(message);this.name='BmsError'}
}
