export const MAXMIND_EDITIONS = Object.freeze([
    Object.freeze({
        key: 'country',
        name: 'GeoLite2-Country',
        fileName: 'GeoLite2-Country.mmdb',
    }),
    Object.freeze({
        key: 'asn',
        name: 'GeoLite2-ASN',
        fileName: 'GeoLite2-ASN.mmdb',
    }),
]);

export function findMaxMindEdition(name) {
    return MAXMIND_EDITIONS.find((edition) => edition.name === name) ?? null;
}
