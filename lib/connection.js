/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 *
 */
'use strict';

var frames = require('./frames.js');
var log = require('./log.js');
var types = require('./types.js');
var util = require('./util.js');
var EndpointState = require('./endpoint.js');
var Session = require('./session.js');

var net = require("net");
var EventEmitter = require('events').EventEmitter;

function get_socket_id(socket) {
    return socket.localAddress + ':' + socket.localPort + ' -> ' + socket.remoteAddress + ':' + socket.remotePort;
};

function session_per_connection(conn) {
    var ssn = null;
    return {
        'get_session' : function () {
            if (!ssn) {
                ssn = conn.create_session();
                ssn.begin();
            }
            return ssn;
        }
    };
};

var conn_counter = 1;

var Connection = function (options, container) {
    this.options = options ? Object.create(options) : {};
    this.container = container;
    if (!this.options.id) {
        this.options.id = 'connection-' + conn_counter++;
    }
    if (!container && !this.options.container_id) {
        this.options.container_id = util.generate_uuid();
    }
    this.registered = false;
    this.state = new EndpointState();
    this.local_channel_map = {};
    this.remote_channel_map = {};
    this.local = {};
    this.remote = {};
    this.local.open = frames.open({'container_id': container ? container.id : this.options.container_id});
    this.local.close = frames.close({});
    this.session_policy = session_per_connection(this);
};

Connection.prototype = Object.create(EventEmitter.prototype);
Connection.prototype.constructor = Connection;
Connection.prototype.dispatch = function(name, context) {
    log.events('Connection got event: ' + name);
    if (this.listeners(name).length) {
        EventEmitter.prototype.emit.apply(this, arguments);
    } else if (this.container) {
        this.container.dispatch.apply(this.container, arguments);
    }
};

Connection.prototype.connect = function () {
    return this.init(net.connect(this.options, this.connected.bind(this)));
};

Connection.prototype.accept = function (socket) {
    log.io('[' + this.id + '] client accepted: '+ get_socket_id(socket));
    return this.init(socket);
};

Connection.prototype.init = function (socket) {
    this.socket = socket;
    this.socket.on('data', this.input.bind(this));
    this.socket.on('error', this.error.bind(this));
    this.socket.on('end', this.eof.bind(this));
    this.pending = [];

    var buffer = new Buffer(8);
    frames.write_header(buffer, {protocol_id:0, major:1, minor:0, revision:0});
    this.pending.push(buffer);
    this.open();
    return this;
};

Connection.prototype.attach_sender = function (options) {
    return this.session_policy.get_session().attach_sender(options);
};

Connection.prototype.attach_receiver = function (options) {
    return this.session_policy.get_session().attach_receiver(options);
};

Connection.prototype.get_option = function (name, default_value) {
    if (this.options[name] !== undefined) return this.options[name];
    else if (this.container) return this.container.get_option(name, default_value);
    else return default_value;
};

Connection.prototype.connected = function () {
    log.io('[' + this.options.id + '] connected ' + get_socket_id(this.socket));
};
Connection.prototype.output = function (buffer) {
    if (this.socket) {
        for (var i = 0; i < this.pending.length; i++) {
            this.socket.write(this.pending[i]);
            log.raw('[' + this.options.id + '] SENT: ' + JSON.stringify(this.pending[i]));
        }
        this.pending = [];
        this.socket.write(buffer);
        log.raw('[' + this.options.id + '] SENT: ' + JSON.stringify(buffer));
        if (this.is_closed()) {
            this.socket.end();
        }
    } else {
        this.pending.push(buffer);
    }
};

Connection.prototype.input = function (buff) {
    log.io('[' + this.options.id + '] read ' + buff.length + ' bytes');
    var buffer;
    if (this.previous_input) {
        buffer = Buffer.concat([this.previous, buff], this.previous.size() + buff.size());
        this.previous_input = null;
    } else {
        buffer = buff;
    }
    var offset = 0;
    if (!this.header_received) {
        if (buffer.length < 8) {
            this.previous_input = buffer;
            return;
        } else {
            this.header_received = frames.read_header(buffer);
            log.frames('[' + this.options.id + '] RECV: ' + JSON.stringify(this.header_received));
            offset = 8;
        }
    }
    while (offset < buffer.length) {
        var frame_size = buffer.readUInt32BE(offset);
        log.io('[' + this.options.id + '] got frame of size ' + frame_size);
        if (buffer.length < offset + frame_size) {
            log.io('[' + this.options.id + '] incomplete frame; have only ' + (buffer.length - offset) + ' of ' + frame_size);
            //don't have enough data for a full frame yet
            this.previous_input = buffer.slice(offset);
            break;
        } else {
            var frame = frames.read_frame(buffer.slice(offset, offset + frame_size));
            log.frames('[' + this.options.id + '] RECV: ' + JSON.stringify(frame));
            offset += frame_size;
            frame.performative.dispatch(this, frame);
        }
    }
};
Connection.prototype.error = function (e) {
    console.log('[' + this.options.id + '] error: ' + e);
};
Connection.prototype.eof = function () {
    if (!this.is_closed()) {
        console.log('[' + this.options.id + '] disconnected');
    }
};

Connection.prototype.open = function () {
    if (this.state.open()) {
        this._register();
    }
};
Connection.prototype.close = function () {
    if (this.state.close()) {
        this._register();
    }
};
Connection.prototype.is_open = function () {
    return this.state.is_open();
};
Connection.prototype.is_closed = function () {
    return this.state.is_closed();
};

Connection.prototype.create_session = function () {
    var i = 0;
    while (this.local_channel_map[i]) i++;
    var session = new Session(this, i);
    this.local_channel_map[i] = session;
    return session;
}

Connection.prototype.on_open = function (frame) {
    if (this.state.remote_opened()) {
        this.remote.open = frame.performative;
        this.dispatch('connection_open', this._context());
        this.open();
    } else {
        throw Error('Open already received');
    }
};

Connection.prototype.on_close = function (frame) {
    if (this.state.remote_closed()) {
        this.remote.close = frame.performative;
        this.dispatch('connection_close', this._context());
        this.close();
    } else {
        throw Error('Close already received');
    }
};

Connection.prototype._register = function () {
    if (!this.registered) {
        this.registered = true;
        process.nextTick(this._process.bind(this));
    }
};

Connection.prototype._process = function () {
    this.registered = false;
    do {
        if (this.state.need_open()) {
            this._write_open();
        }
        for (var k in this.local_channel_map) {
            this.local_channel_map[k]._process();
        }
        if (this.state.need_close()) {
            this._write_close();
        }
    } while (!this.state.has_settled());
};

Connection.prototype._write_frame = function (channel, frame, payload) {
    var buffer = new Buffer(1024);//TODO: proper sizing
    log.frames('[' + this.options.id + '] SENT: ' + JSON.stringify(frame));
    var len = frames.write_amqp_frame(buffer, channel, frame, payload);
    this.output(buffer.slice(0, len));
};

Connection.prototype._write_open = function () {
    this._write_frame(0, this.local.open.described());
};

Connection.prototype._write_close = function () {
    this._write_frame(0, this.local.close.described());
};

Connection.prototype.on_begin = function (frame) {
    var session;
    if (frame.performative.remote_channel === null || frame.performative.remote_channel === undefined) {
        //peer initiated
        session = this.create_session();
        session.local.begin.remote_channel = frame.channel;
    } else {
        session = this.local_channel_map[frame.performative.remote_channel];
        if (!session) throw Error('Invalid value for remote channel ' + frame.performative.remote_channel);
    }
    session.on_begin(frame);
    this.remote_channel_map[frame.channel] = session;
};

Connection.prototype._context = function (c) {
    var context = c ? c : {};
    context.connection = this;
    if (this.container) context.container = this.container;
    return context;
};

function delegate_to_session(name) {
    Connection.prototype['on_' + name] = function (frame) {
        var session = this.remote_channel_map[frame.channel];
        if (!session) {
            throw Error(name + ' received on invalid channel ' + frame.channel);
        }
        session['on_' + name](frame);
    };
};

delegate_to_session('end');
delegate_to_session('attach');
delegate_to_session('detach');
delegate_to_session('transfer');
delegate_to_session('disposition');
delegate_to_session('flow');

module.exports = Connection