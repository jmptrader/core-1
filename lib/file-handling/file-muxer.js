'use strict';

var assert = require('assert');
var stream = require('readable-stream');
var inherits = require('util').inherits;
var merge = require('merge');

/**
 * Accepts multiple ordered input sources and exposes them as a single
 * contiguous readable stream. Used for re-assembly of shards.
 * @constructor
 * @license LGPL-3.0
 * @param {Object} options
 * @param {Number} options.shards - Number of total shards to be multiplexed
 * @param {Number} options.length - Number of total bytes of input
 * @param {Number} options.sourceDrainWait - Time to wait for a new input after
 * all inputs are drained before entire stream is consumed
 * @param {Number} options.sourceIdleWait - Time to wait for source to make
 * more data available between next read
 * @fires FileMuxer#drain
 */
function FileMuxer(options) {
  if (!(this instanceof FileMuxer)) {
    return new FileMuxer(options);
  }

  this._checkOptions(options);

  this._shards = options.shards;
  this._length = options.length;
  this._inputs = [];
  this._bytesRead = 0;
  this._added = 0;
  this._options = merge(Object.create(FileMuxer.DEFAULTS), options);

  stream.Readable.call(this);
}

FileMuxer.DEFAULTS = {
  sourceDrainWait: 2000,
  sourceIdleWait: 50
};

/**
 * Triggered when the muxer has drained one of the supplied inputs
 * @event FileMuxer#drain
 * @param {ReadableStream} input - The drained input stream
 */

inherits(FileMuxer, stream.Readable);

/**
 * Checks the options supplied to the constructor
 * @private
 */
FileMuxer.prototype._checkOptions = function(options) {
  var shards = options.shards;
  var length = options.length;

  assert(typeof shards === 'number', 'You must supply a shards parameter');
  assert(shards > 0, 'Cannot multiplex a 0 shard stream');
  assert(typeof length === 'number', 'You must supply a length parameter');
  assert(length > 0, 'Cannot multiplex a 0 length stream');
};

/**
 * Implements the underlying read method
 * @private
 */
FileMuxer.prototype._read = function() {
  var self = this;

  function _waitForSourceAvailable() {
    self.once('sourceAdded', self._read.bind(self));

    self._sourceDrainTimeout = setTimeout(function() {
      self.removeAllListeners('sourceAdded');
      self.emit('error', new Error('Unexpected end of source stream'));
    }, self._options.sourceDrainWait);
  }

  function _mux(bytes) {
    self._bytesRead += bytes.length;

    if (self._length < self._bytesRead) {
      return self.emit('error', new Error('Input exceeds expected length'));
    }

    self.push(bytes);
  }

  function _readFromSource() {
    var bytes = self._inputs[0] ? self._inputs[0].read() : null;

    if (bytes !== null) {
      return _mux(bytes);
    }

    setTimeout(_readFromSource, self._options.sourceIdleWait);
  }

  if (this._sourceDrainTimeout) {
    clearTimeout(this._sourceDrainTimeout);
  }

  if (this._bytesRead === this._length) {
    return this.push(null);
  }

  if (!this._inputs[0]) {
    return _waitForSourceAvailable();
  }

  _readFromSource();
};

/**
 * Adds an additional input stream to the multiplexer
 * @param {ReadableStream} readable - Readable input stream from file shard
 */
FileMuxer.prototype.addInputSource = function(readable) {
  assert(typeof readable.pipe === 'function', 'Invalid input stream supplied');
  assert(this._added < this._shards, 'Inputs exceed defined number of shards');

  var self = this;
  var input = readable.pipe(stream.PassThrough()).pause();

  input.on('end', function() {
    self._inputs.splice(self._inputs.indexOf(input), 1);
    self.emit('drain', input);
  });

  readable.on('error', function(err) {
    self.emit('error', err);
  });

  this._added++;
  this._inputs.push(input);
  this.emit('sourceAdded');

  return this;
};

module.exports = FileMuxer;
