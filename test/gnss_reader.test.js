const test = require('node:test');
const assert = require('node:assert');
const { GnssReader, parseNmeaLatLon } = require('../radio/gnss_reader.js');

test('GnssReader: parses NMEA Lat Lon correctly', () => {
    assert.strictEqual(parseNmeaLatLon('4807.038', 'N').toFixed(5), '48.11730');
    assert.strictEqual(parseNmeaLatLon('01131.000', 'E').toFixed(5), '11.51667');
    assert.strictEqual(parseNmeaLatLon('3436.9631', 'S').toFixed(5), '-34.61605');
});

test('GnssReader: parse GPRMC', () => {
    let pos = null;
    const reader = new GnssReader({
        onPosition: (p) => pos = p
    });
    
    // Active fix
    reader._handleLine('$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6A');
    assert.ok(reader.state.fix);
    assert.strictEqual(reader.state.lat.toFixed(5), '48.11730');
    assert.strictEqual(reader.state.lon.toFixed(5), '11.51667');
    assert.deepStrictEqual(pos.lat, reader.state.lat);
    
    // Void fix
    reader._handleLine('$GPRMC,123519,V,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6A');
    assert.strictEqual(reader.state.fix, false);
});

test('GnssReader: parse GPGGA', () => {
    let pos = null;
    const reader = new GnssReader({
        onPosition: (p) => pos = p
    });
    
    reader._handleLine('$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47');
    assert.ok(reader.state.fix);
    assert.strictEqual(reader.state.alt, 545.4);
});

test('GnssReader: parse HEHDT', () => {
    let heading = null;
    const reader = new GnssReader({
        onHeading: (h) => heading = h
    });
    
    reader._handleLine('$HEHDT,145.2,T*2B');
    assert.strictEqual(reader.state.heading, 145.2);
    assert.strictEqual(heading, 145.2);
});

test('GnssReader: connect failure without transport (browser simulation)', async () => {
    // Override isSupported for this test
    const orig = GnssReader.isSupported;
    GnssReader.isSupported = () => false;
    
    const reader = new GnssReader();
    const result = await reader.connect();
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'WEB_SERIAL_NO_DISPONIBLE');
    
    GnssReader.isSupported = orig;
});
