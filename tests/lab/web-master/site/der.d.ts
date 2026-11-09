// Types of der.js for the Node tests of the P1363 and DER signature forms.
export declare const p1363ToDer: (signature: Uint8Array) => Uint8Array<ArrayBuffer>;
export declare const derToP1363: (der: Uint8Array) => Uint8Array<ArrayBuffer>;
