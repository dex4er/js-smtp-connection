'use strict'

const packageInfo = require('../package.json')
const EventEmitter = require('events').EventEmitter
const net = require('net')
const tls = require('tls')
const os = require('os')
const crypto = require('crypto')
const DataStream = require('./data-stream')
const PassThrough = require('stream').PassThrough
const logger = require('./logger')
const ntlm = require('httpntlm/ntlm')

// default timeout values in ms
const CONNECTION_TIMEOUT = 2 * 60 * 1000 // how much to wait for the connection to be established
const SOCKET_TIMEOUT = 10 * 60 * 1000 // how much to wait for socket inactivity before disconnecting the client
const GREETING_TIMEOUT = 30 * 1000 // how much to wait after connection is established but SMTP greeting is not receieved

/**
 * Generates a SMTP connection object
 *
 * Optional options object takes the following possible properties:
 *
 *  * **port** - is the port to connect to (defaults to 25 or 465)
 *  * **host** - is the hostname or IP address to connect to (defaults to 'localhost')
 *  * **secure** - use SSL
 *  * **ignoreTLS** - ignore server support for STARTTLS
 *  * **requireTLS** - forces the client to use STARTTLS
 *  * **name** - the name of the client server
 *  * **localAddress** - outbound address to bind to (see: http://nodejs.org/api/net.html#net_net_connect_options_connectionlistener)
 *  * **greetingTimeout** - Time to wait in ms until greeting message is received from the server (defaults to 10000)
 *  * **connectionTimeout** - how many milliseconds to wait for the connection to establish
 *  * **socketTimeout** - Time of inactivity until the connection is closed (defaults to 1 hour)
 *  * **lmtp** - if true, uses LMTP instead of SMTP protocol
 *  * **logger** - bunyan compatible logger interface
 *  * **debug** - if true pass SMTP traffic to the logger
 *  * **tls** - options for createCredentials
 *  * **socket** - existing socket to use instead of creating a new one (see: http://nodejs.org/api/net.html#net_class_net_socket)
 *  * **secured** - boolean indicates that the provided socket has already been upgraded to tls
 *
 * @constructor
 * @namespace SMTP Client module
 * @param {Object} [options] Option properties
 */
class SMTPConnection extends EventEmitter {
  constructor (options) {
    super(options)

    this.id = crypto.randomBytes(8).toString('base64').replace(/\W/g, '')
    this.stage = 'init'

    this.options = options || {}

    this.component = this.options.component || 'smtp-connection'

    this.secureConnection = !!this.options.secure
    this.alreadySecured = !!this.options.secured

    this.port = this.options.port || (this.secureConnection ? 465 : 25)
    this.host = this.options.host || 'localhost'

    if (typeof this.options.secure === 'undefined' && this.port === 465) {
      // if secure option is not set but port is 465, then default to secure
      this.secureConnection = true
    }

    this.name = this.options.name || this._getHostname()

    // If true then log metainfo as first argument (needed for *real* bunyan)
    this.structuredLogger = this.options.structuredLogger && this.options.logger && typeof this.options.logger === 'object'

    // autodetect bunyan
    if (!('structuredLogger' in this.options) && this.options.logger && typeof this.options.logger === 'object' && this.options.logger.fields) {
      this.structuredLogger = true
    }

    this.logger = logger.getLogger(this.options)

    /**
     * Expose version nr, just for the reference
     * @type {String}
     */
    this.version = packageInfo.version

    /**
     * If true, then the user is authenticated
     * @type {Boolean}
     */
    this.authenticated = false

    /**
     * If set to true, this instance is no longer active
     * @private
     */
    this.destroyed = false

    /**
     * Defines if the current connection is secure or not. If not,
     * STARTTLS can be used if available
     * @private
     */
    this.secure = !!this.secureConnection

    /**
     * Store incomplete messages coming from the server
     * @private
     */
    this._remainder = ''

    /**
     * Unprocessed responses from the server
     * @type {Array}
     */
    this._responseQueue = []

    /**
     * The socket connecting to the server
     * @publick
     */
    this._socket = false

    /**
     * Lists supported auth mechanisms
     * @private
     */
    this._supportedAuth = []

    /**
     * Includes current envelope (from, to)
     * @private
     */
    this._envelope = false

    /**
     * Lists supported extensions
     * @private
     */
    this._supportedExtensions = []

    /**
     * Defines the maximum allowed size for a single message
     * @private
     */
    this._maxAllowedSize = 0

    /**
     * Function queue to run if a data chunk comes from the server
     * @private
     */
    this._responseActions = []
    this._recipientQueue = []

    /**
     * Timeout variable for waiting the greeting
     * @private
     */
    this._greetingTimeout = false

    /**
     * Timeout variable for waiting the connection to start
     * @private
     */
    this._connectionTimeout = false

    /**
     * If the socket is deemed already closed
     * @private
     */
    this._destroyed = false

    /**
     * If the socket is already being closed
     * @private
     */
    this._closing = false
  }

  /**
   * Creates a connection to a SMTP server and sets up connection
   * listener
   */
  connect (connectCallback) {
    if (typeof connectCallback === 'function') {
      this.once('connect', () => {
        this._log({
          level: 'debug',
          tnx: 'smtp'
        }, 'SMTP handshake finished')
        connectCallback()
      })
    }

    let opts = {
      port: this.port,
      host: this.host
    }

    if (this.options.localAddress) {
      opts.localAddress = this.options.localAddress
    }

    if (this.options.connection) {
      // connection is already opened
      this._socket = this.options.connection
      if (this.secureConnection && !this.alreadySecured) {
        setImmediate(() => this._upgradeConnection(err => {
          if (err) {
            this._onError(new Error('Error initiating TLS - ' + (err.message || err)), 'ETLS', false, 'CONN')
            return
          }
          this._onConnect()
        }))
      } else {
        setImmediate(() => this._onConnect())
      }
    } else if (this.options.socket) {
      // socket object is set up but not yet connected
      this._socket = this.options.socket
      try {
        this._socket.connect(this.port, this.host, () => {
          this._socket.setKeepAlive(true)
          this._onConnect()
        })
      } catch (E) {
        return setImmediate(() => this._onError(E, 'ECONNECTION', false, 'CONN'))
      }
    } else if (this.secureConnection) {
      // connect using tls
      if (this.options.tls) {
        Object.keys(this.options.tls).forEach(key => {
          opts[key] = this.options.tls[key]
        })
      }
      try {
        this._socket = tls.connect(this.port, this.host, opts, () => {
          this._socket.setKeepAlive(true)
          this._onConnect()
        })
      } catch (E) {
        return setImmediate(() => this._onError(E, 'ECONNECTION', false, 'CONN'))
      }
    } else {
      // connect using plaintext
      try {
        this._socket = net.connect(opts, () => {
          this._socket.setKeepAlive(true)
          this._onConnect()
        })
      } catch (E) {
        return setImmediate(() => this._onError(E, 'ECONNECTION', false, 'CONN'))
      }
    }

    this._connectionTimeout = setTimeout(() => {
      this._onError('Connection timeout', 'ETIMEDOUT', false, 'CONN')
    }, this.options.connectionTimeout || CONNECTION_TIMEOUT)

    this._socket.on('error', err => {
      this._onError(err, 'ECONNECTION', false, 'CONN')
    })
  }

  /**
   * Sends QUIT
   */
  quit () {
    this._sendCommand('QUIT')
    this._responseActions.push(this.close)
  }

  /**
   * Closes the connection to the server
   */
  close () {
    clearTimeout(this._connectionTimeout)
    clearTimeout(this._greetingTimeout)
    this._responseActions = []

    // allow to run this function only once
    if (this._closing) {
      return
    }
    this._closing = true

    let closeMethod = 'end'

    if (this.stage === 'init') {
      // Close the socket immediately when connection timed out
      closeMethod = 'destroy'
    }

    this._log({
      level: 'debug',
      tnx: 'smtp'
    }, 'Closing connection to the server using "%s"', closeMethod)

    let socket = (this._socket && this._socket.socket) || this._socket

    if (socket && !socket.destroyed) {
      try {
        this._socket[closeMethod]()
      } catch (E) {
        // just ignore
      }
    }

    this._destroy()
  }

  /**
   * Authenticate user
   */
  login (authData, callback) {
    this._auth = authData || {}
    this._user = (this._auth.xoauth2 && this._auth.xoauth2.options && this._auth.xoauth2.options.user) || this._auth.user || ''

    this._authMethod = false
    if (this.options.authMethod) {
      this._authMethod = this.options.authMethod.toUpperCase().trim()
    } else if (this._auth.xoauth2 && this._supportedAuth.indexOf('XOAUTH2') >= 0) {
      this._authMethod = 'XOAUTH2'
    } else if (this._auth.domain && this._supportedAuth.indexOf('NTLM') >= 0) {
      this._authMethod = 'NTLM'
    } else {
      // use first supported
      this._authMethod = (this._supportedAuth[0] || 'PLAIN').toUpperCase().trim()
    }

    switch (this._authMethod) {
      case 'XOAUTH2':
        this._handleXOauth2Token(false, callback)
        return
      case 'LOGIN':
        this._responseActions.push(str => {
          this._actionAuthLoginUser(str, callback)
        })
        this._sendCommand('AUTH LOGIN')
        return
      case 'PLAIN':
        this._responseActions.push(str => {
          this._actionAUTHComplete(str, callback)
        })
        this._sendCommand(
          'AUTH PLAIN ' + new Buffer(
          // this._auth.user+'\u0000'+
          '\u0000' + // skip authorization identity as it causes problems with some servers
          this._auth.user + '\u0000' +
          this._auth.pass, 'utf-8').toString('base64')
        )
        return
      case 'CRAM-MD5':
        this._responseActions.push(str => {
          this._actionAuthCramMd5(str, callback)
        })
        this._sendCommand('AUTH CRAM-MD5')
        return
      case 'NTLM':
        this._responseActions.push(str => {
          this._actionAuthNtlmType1(str, callback)
        })
        this._sendCommand('AUTH ' + ntlm.createType1Message({
          domain: this._auth.domain || '',
          workstation: this._auth.workstation || ''
        }))
        return
    }

    return callback(this._formatError('Unknown authentication method "' + this._authMethod + '"', 'EAUTH', false, 'API'))
  }

  /**
   * Sends a message
   *
   * @param {Object} envelope Envelope object, {from: addr, to: [addr]}
   * @param {Object} message String, Buffer or a Stream
   * @param {Function} callback Callback to return once sending is completed
   */
  send (envelope, message, done) {
    if (!message) {
      return done(this._formatError('Empty message', 'EMESSAGE', false, 'API'))
    }

    // reject larger messages than allowed
    if (this._maxAllowedSize && envelope.size > this._maxAllowedSize) {
      return setImmediate(() => {
        done(this._formatError('Message size larger than allowed ' + this._maxAllowedSize, 'EMESSAGE', false, 'MAIL FROM'))
      })
    }

    // ensure that callback is only called once
    let returned = false
    let callback = function () {
      if (returned) {
        return
      }
      returned = true

      done(...arguments)
    }

    if (typeof message.on === 'function') {
      message.on('error', err => callback(this._formatError(err, 'ESTREAM', false, 'API')))
    }

    this._setEnvelope(envelope, (err, info) => {
      if (err) {
        return callback(err)
      }
      if (this.options.envelopeOnly) {
        return callback(null, info)
      }
      let stream = this._createSendStream((err, str) => {
        if (err) {
          return callback(err)
        }
        info.response = str
        return callback(null, info)
      })
      if (typeof message.pipe === 'function') {
        message.pipe(stream)
      } else {
        stream.write(message)
        stream.end()
      }
    })
  }

  /**
   * Resets connection state
   *
   * @param {Function} callback Callback to return once connection is reset
   */
  reset (callback) {
    this._sendCommand('RSET')
    this._responseActions.push(str => {
      if (str.charAt(0) !== '2') {
        return callback(this._formatError('Could not reset session state:\n' + str, 'EPROTOCOL', str, 'RSET'))
      }
      this._envelope = false
      return callback(null, true)
    })
  }

  /**
   * Connection listener that is run when the connection to
   * the server is opened
   *
   * @event
   */
  _onConnect () {
    clearTimeout(this._connectionTimeout)

    this._log({
      level: 'info',
      tnx: 'network',
      localAddress: this._socket.localAddress,
      localPort: this._socket.localPort,
      remoteAddress: this._socket.remoteAddress,
      remotePort: this._socket.remotePort
    }, '%s established to %s:%s', this.secure ? 'Secure connection' : 'Connection', this._socket.remoteAddress, this._socket.remotePort)

    if (this._destroyed) {
      // Connection was established after we already had canceled it
      this.close()
      return
    }

    this.stage = 'connected'

    // clear existing listeners for the socket
    this._socket.removeAllListeners('data')
    this._socket.removeAllListeners('timeout')
    this._socket.removeAllListeners('close')
    this._socket.removeAllListeners('end')

    this._socket.on('data', chunk => this._onData(chunk))
    this._socket.once('close', errored => this._onClose(errored))
    this._socket.once('end', () => this._onEnd())

    this._socket.setTimeout(this.options.socketTimeout || SOCKET_TIMEOUT)
    this._socket.on('timeout', () => this._onTimeout())

    this._greetingTimeout = setTimeout(() => {
      // if still waiting for greeting, give up
      if (this._socket && !this._destroyed && this._responseActions[0] === this._actionGreeting) {
        this._onError('Greeting never received', 'ETIMEDOUT', false, 'CONN')
      }
    }, this.options.greetingTimeout || GREETING_TIMEOUT)

    this._responseActions.push(this._actionGreeting)

    // we have a 'data' listener set up so resume socket if it was paused
    this._socket.resume()
  }

  /**
   * 'data' listener for data coming from the server
   *
   * @event
   * @param {Buffer} chunk Data chunk coming from the server
   */
  _onData (chunk) {
    if (this._destroyed || !chunk || !chunk.length) {
      return
    }

    let data = (chunk || '').toString('binary')
    let lines = (this._remainder + data).split(/\r?\n/)
    let lastline

    this._remainder = lines.pop()

    for (let i = 0, len = lines.length; i < len; i++) {
      if (this._responseQueue.length) {
        lastline = this._responseQueue[this._responseQueue.length - 1]
        if (/^\d+-/.test(lastline.split('\n').pop())) {
          this._responseQueue[this._responseQueue.length - 1] += '\n' + lines[i]
          continue
        }
      }
      this._responseQueue.push(lines[i])
    }

    this._processResponse()
  }

  /**
   * 'error' listener for the socket
   *
   * @event
   * @param {Error} err Error object
   * @param {String} type Error name
   */
  _onError (err, type, data, command) {
    clearTimeout(this._connectionTimeout)
    clearTimeout(this._greetingTimeout)

    if (this._destroyed) {
      // just ignore, already closed
      // this might happen when a socket is canceled because of reached timeout
      // but the socket timeout error itself receives only after
      return
    }

    err = this._formatError(err, type, data, command)

    this._log({
      level: 'error',
      err
    }, err.message)

    this.emit('error', err)
    this.close()
  }

  _formatError (message, type, response, command) {
    let err

    if (/Error\]$/i.test(Object.prototype.toString.call(message))) {
      err = message
    } else {
      err = new Error(message)
    }

    if (type && type !== 'Error') {
      err.code = type
    }

    if (response) {
      err.response = response
      err.message += ': ' + response
    }

    let responseCode = (typeof response === 'string' && Number((response.match(/^\d+/) || [])[0])) || false
    if (responseCode) {
      err.responseCode = responseCode
    }

    if (command) {
      err.command = command
    }

    return err
  }

  /**
   * 'close' listener for the socket
   *
   * @event
   */
  _onClose () {
    this._log({
      level: 'info',
      tnx: 'network'
    }, 'Connection closed')

    if ([this._actionGreeting, this.close].indexOf(this._responseActions[0]) < 0 && !this._destroyed) {
      return this._onError(new Error('Connection closed unexpectedly'), 'ECONNECTION', false, 'CONN')
    }

    this._destroy()
  }

  /**
   * 'end' listener for the socket
   *
   * @event
   */
  _onEnd () {
    this._destroy()
  }

  /**
   * 'timeout' listener for the socket
   *
   * @event
   */
  _onTimeout () {
    return this._onError(new Error('Timeout'), 'ETIMEDOUT', false, 'CONN')
  }

  /**
   * Destroys the client, emits 'end'
   */
  _destroy () {
    if (this._destroyed) {
      return
    }
    this._destroyed = true
    this.emit('end')
  }

  /**
   * Upgrades the connection to TLS
   *
   * @param {Function} callback Callback function to run when the connection
   *        has been secured
   */
  _upgradeConnection (callback) {
    // do not remove all listeners or it breaks node v0.10 as there's
    // apparently a 'finish' event set that would be cleared as well

    // we can safely keep 'error', 'end', 'close' etc. events
    this._socket.removeAllListeners('data') // incoming data is going to be gibberish from this point onwards
    this._socket.removeAllListeners('timeout') // timeout will be re-set for the new socket object

    let socketPlain = this._socket
    let opts = {
      socket: this._socket,
      host: this.host
    }

    Object.keys(this.options.tls || {}).forEach(key => {
      opts[key] = this.options.tls[key]
    })

    this.upgrading = true
    this._socket = tls.connect(opts, () => {
      this.secure = true
      this.upgrading = false
      this._socket.on('data', chunk => this._onData(chunk))

      socketPlain.removeAllListeners('close')
      socketPlain.removeAllListeners('end')

      return callback(null, true)
    })

    this._socket.on('error', err => this._onError(err))
    this._socket.once('close', errored => this._onClose(errored))
    this._socket.once('end', () => this._onEnd())

    this._socket.setTimeout(this.options.socketTimeout || SOCKET_TIMEOUT) // 10 min.
    this._socket.on('timeout', () => this._onTimeout())

    // resume in case the socket was paused
    socketPlain.resume()
  }

  /**
   * Processes queued responses from the server
   *
   * @param {Boolean} force If true, ignores _processing flag
   */
  _processResponse () {
    if (!this._responseQueue.length) {
      return false
    }

    let str = (this._responseQueue.shift() || '').toString()

    if (/^\d+-/.test(str.split('\n').pop())) {
            // keep waiting for the final part of multiline response
      return
    }

    if (this.options.debug || this.options.transactionLog) {
      this._log({
        level: 'debug',
        tnx: 'server'
      }, str.replace(/\r?\n$/, ''))
    }

    if (!str.trim()) { // skip unexpected empty lines
      setImmediate(() => this._processResponse(true))
    }

    let action = this._responseActions.shift()

    if (typeof action === 'function') {
      action.call(this, str)
      setImmediate(() => this._processResponse(true))
    } else {
      return this._onError(new Error('Unexpected Response'), 'EPROTOCOL', str, 'CONN')
    }
  }

  /**
   * Send a command to the server, append \r\n
   *
   * @param {String} str String to be sent to the server
   */
  _sendCommand (str) {
    if (this._destroyed) {
            // Connection already closed, can't send any more data
      return
    }

    if (this._socket.destroyed) {
      return this.close()
    }

    if (this.options.debug || this.options.transactionLog) {
      this._log({
        level: 'debug',
        tnx: 'client'
      }, (str || '').toString().replace(/\r?\n$/, ''))
    }

    this._socket.write(new Buffer(str + '\r\n', 'utf-8'))
  }

  /**
   * Initiates a new message by submitting envelope data, starting with
   * MAIL FROM: command
   *
   * @param {Object} envelope Envelope object in the form of
   *        {from:'...', to:['...']}
   *        or
   *        {from:{address:'...',name:'...'}, to:[address:'...',name:'...']}
   */
  _setEnvelope (envelope, callback) {
    let args = []
    let useSmtpUtf8 = false

    this._envelope = envelope || {}
    this._envelope.from = ((this._envelope.from && this._envelope.from.address) || this._envelope.from || '').toString().trim()

    this._envelope.to = [].concat(this._envelope.to || []).map(to => ((to && to.address) || to || '').toString().trim())

    if (!this._envelope.to.length) {
      return callback(this._formatError('No recipients defined', 'EENVELOPE', false, 'API'))
    }

    if (this._envelope.from && /[\r\n<>]/.test(this._envelope.from)) {
      return callback(this._formatError('Invalid sender ' + JSON.stringify(this._envelope.from), 'EENVELOPE', false, 'API'))
    }

    // check if the sender address uses only ASCII characters,
    // otherwise require usage of SMTPUTF8 extension
    if (/[\x80-\uFFFF]/.test(this._envelope.from)) {
      useSmtpUtf8 = true
    }

    for (let i = 0, len = this._envelope.to.length; i < len; i++) {
      if (!this._envelope.to[i] || /[\r\n<>]/.test(this._envelope.to[i])) {
        return callback(this._formatError('Invalid recipient ' + JSON.stringify(this._envelope.to[i]), 'EENVELOPE', false, 'API'))
      }

      // check if the recipients addresses use only ASCII characters,
      // otherwise require usage of SMTPUTF8 extension
      if (/[\x80-\uFFFF]/.test(this._envelope.to[i])) {
        useSmtpUtf8 = true
      }
    }

    // clone the recipients array for latter manipulation
    this._envelope.rcptQueue = JSON.parse(JSON.stringify(this._envelope.to || []))
    this._envelope.rejected = []
    this._envelope.rejectedErrors = []
    this._envelope.accepted = []

    if (this._envelope.dsn) {
      try {
        this._envelope.dsn = this._setDsnEnvelope(this._envelope.dsn)
      } catch (err) {
        return callback(this._formatError('Invalid dsn ' + err.message, 'EENVELOPE', false, 'API'))
      }
    }

    this._responseActions.push(str => {
      this._actionMAIL(str, callback)
    })

    // If the server supports SMTPUTF8 and the envelope includes an internationalized
    // email address then append SMTPUTF8 keyword to the MAIL FROM command
    if (useSmtpUtf8 && this._supportedExtensions.indexOf('SMTPUTF8') >= 0) {
      args.push('SMTPUTF8')
      this._usingSmtpUtf8 = true
    }

    // If the server supports 8BITMIME and the message might contain non-ascii bytes
    // then append the 8BITMIME keyword to the MAIL FROM command
    if (this._envelope.use8BitMime && this._supportedExtensions.indexOf('8BITMIME') >= 0) {
      args.push('BODY=8BITMIME')
      this._using8BitMime = true
    }

    if (this._envelope.size && this._supportedExtensions.indexOf('SIZE') >= 0) {
      args.push('SIZE=' + this._envelope.size)
    }

    // If the server supports DSN and the envelope includes an DSN prop
    // then append DSN params to the MAIL FROM command
    if (this._envelope.dsn && this._supportedExtensions.indexOf('DSN') >= 0) {
      if (this._envelope.dsn.ret) {
        args.push('RET=' + this._envelope.dsn.ret)
      }
      if (this._envelope.dsn.envid) {
        args.push('ENVID=' + this._envelope.dsn.envid)
      }
    }

    this._sendCommand('MAIL FROM:<' + (this._envelope.from) + '>' + (args.length ? ' ' + args.join(' ') : ''))
  }

  _setDsnEnvelope (params) {
    let ret = params.ret ? params.ret.toString().toUpperCase() : null
    if (ret && ['FULL', 'HDRS'].indexOf(ret) < 0) {
      throw new Error('ret: ' + JSON.stringify(ret))
    }
    let envid = params.envid ? params.envid.toString() : null
    let notify = params.notify ? params.notify : null
    if (notify) {
      if (typeof notify === 'string') {
        notify = notify.split(',')
      }
      notify = notify.map(n => n.trim().toUpperCase())
      let validNotify = ['NEVER', 'SUCCESS', 'FAILURE', 'DELAY']
      let invaliNotify = notify.filter(n => !validNotify.includes(n))
      if (invaliNotify.length || (notify.length > 1 && notify.indexOf('NEVER') >= 0)) {
        throw new Error('notify: ' + JSON.stringify(notify.join(',')))
      }
      notify = notify.join(',')
    }
    let orcpt = params.orcpt ? params.orcpt.toString() : null
    return {
      ret,
      envid,
      notify,
      orcpt
    }
  }

  _getDsnRcptToArgs () {
    let args = []
    // If the server supports DSN and the envelope includes an DSN prop
    // then append DSN params to the RCPT TO command
    if (this._envelope.dsn && this._supportedExtensions.indexOf('DSN') >= 0) {
      if (this._envelope.dsn.notify) {
        args.push('NOTIFY=' + this._envelope.dsn.notify)
      }
      if (this._envelope.dsn.orcpt) {
        args.push('ORCPT=' + this._envelope.dsn.orcpt)
      }
    }
    return (args.length ? ' ' + args.join(' ') : '')
  }

  _createSendStream (callback) {
    let dataStream = new DataStream()
    let logStream

    if (this.options.lmtp) {
      this._envelope.accepted.forEach((recipient, i) => {
        let final = i === this._envelope.accepted.length - 1
        this._responseActions.push(str => {
          this._actionLMTPStream(recipient, final, str, callback)
        })
      })
    } else {
      this._responseActions.push(str => {
        this._actionSMTPStream(str, callback)
      })
    }

    dataStream.pipe(this._socket, {
      end: false
    })

    if (this.options.debug) {
      logStream = new PassThrough()
      logStream.on('readable', () => {
        let chunk
        while ((chunk = logStream.read())) {
          this._log({
            level: 'debug',
            tnx: 'message'
          }, chunk.toString('binary').replace(/\r?\n$/, ''))
        }
      })
      dataStream.pipe(logStream)
    }

    dataStream.once('end', () => {
      this._log({
        level: 'info',
        tnx: 'message',
        inByteCount: dataStream.inByteCount,
        outByteCount: dataStream.outByteCount
      }, '<%s bytes encoded mime message (source size %s bytes)>', dataStream.outByteCount, dataStream.inByteCount)
    })

    return dataStream
  }

  /** ACTIONS **/

  /**
   * Will be run after the connection is created and the server sends
   * a greeting. If the incoming message starts with 220 initiate
   * SMTP session by sending EHLO command
   *
   * @param {String} str Message from the server
   */
  _actionGreeting (str) {
    clearTimeout(this._greetingTimeout)

    if (str.substr(0, 3) !== '220') {
      this._onError(new Error('Invalid greeting from server:\n' + str), 'EPROTOCOL', str, 'CONN')
      return
    }

    if (this.options.lmtp) {
      this._responseActions.push(this._actionLHLO)
      this._sendCommand('LHLO ' + this.name)
    } else {
      this._responseActions.push(this._actionEHLO)
      this._sendCommand('EHLO ' + this.name)
    }
  }

  /**
   * Handles server response for LHLO command. If it yielded in
   * error, emit 'error', otherwise treat this as an EHLO response
   *
   * @param {String} str Message from the server
   */
  _actionLHLO (str) {
    if (str.charAt(0) !== '2') {
      this._onError(new Error('Invalid response for LHLO:\n' + str), 'EPROTOCOL', str, 'LHLO')
      return
    }

    this._actionEHLO(str)
  }

  /**
   * Handles server response for EHLO command. If it yielded in
   * error, try HELO instead, otherwise initiate TLS negotiation
   * if STARTTLS is supported by the server or move into the
   * authentication phase.
   *
   * @param {String} str Message from the server
   */
  _actionEHLO (str) {
    let match

    if (str.substr(0, 3) === '421') {
      this._onError(new Error('Server terminates connection:\n' + str), 'ECONNECTION', str, 'EHLO')
      return
    }

    if (str.charAt(0) !== '2') {
      if (this.options.requireTLS) {
        this._onError(new Error('EHLO failed but HELO does not support required STARTTLS:\n' + str), 'ECONNECTION', str, 'EHLO')
        return
      }

      // Try HELO instead
      this._responseActions.push(this._actionHELO)
      this._sendCommand('HELO ' + this.name)
      return
    }

    // Detect if the server supports STARTTLS
    if (!this.secure && !this.options.ignoreTLS && (/[ -]STARTTLS\b/mi.test(str) || this.options.requireTLS)) {
      this._sendCommand('STARTTLS')
      this._responseActions.push(this._actionSTARTTLS)
      return
    }

    // Detect if the server supports SMTPUTF8
    if (/[ -]SMTPUTF8\b/mi.test(str)) {
      this._supportedExtensions.push('SMTPUTF8')
    }

    // Detect if the server supports DSN
    if (/[ -]DSN\b/mi.test(str)) {
      this._supportedExtensions.push('DSN')
    }

    // Detect if the server supports 8BITMIME
    if (/[ -]8BITMIME\b/mi.test(str)) {
      this._supportedExtensions.push('8BITMIME')
    }

    // Detect if the server supports PIPELINING
    if (/[ -]PIPELINING\b/mi.test(str)) {
      this._supportedExtensions.push('PIPELINING')
    }

    // Detect if the server supports PLAIN auth
    if (/AUTH(?:(\s+|=)[^\n]*\s+|\s+|=)PLAIN/i.test(str)) {
      this._supportedAuth.push('PLAIN')
    }

    // Detect if the server supports LOGIN auth
    if (/AUTH(?:(\s+|=)[^\n]*\s+|\s+|=)LOGIN/i.test(str)) {
      this._supportedAuth.push('LOGIN')
    }

    // Detect if the server supports CRAM-MD5 auth
    if (/AUTH(?:(\s+|=)[^\n]*\s+|\s+|=)CRAM-MD5/i.test(str)) {
      this._supportedAuth.push('CRAM-MD5')
    }

    // Detect if the server supports XOAUTH2 auth
    if (/AUTH(?:(\s+|=)[^\n]*\s+|\s+|=)XOAUTH2/i.test(str)) {
      this._supportedAuth.push('XOAUTH2')
    }

    // Detect if the server supports SIZE extensions (and the max allowed size)
    if ((match = str.match(/[ -]SIZE(?:[ \t]+(\d+))?/mi))) {
      this._supportedExtensions.push('SIZE')
      this._maxAllowedSize = Number(match[1]) || 0
    }

    this.emit('connect')
  }

  /**
   * Handles server response for HELO command. If it yielded in
   * error, emit 'error', otherwise move into the authentication phase.
   *
   * @param {String} str Message from the server
   */
  _actionHELO (str) {
    if (str.charAt(0) !== '2') {
      this._onError(new Error('Invalid response for EHLO/HELO:\n' + str), 'EPROTOCOL', str, 'HELO')
      return
    }

    this.emit('connect')
  }

  /**
   * Handles server response for STARTTLS command. If there's an error
   * try HELO instead, otherwise initiate TLS upgrade. If the upgrade
   * succeedes restart the EHLO
   *
   * @param {String} str Message from the server
   */
  _actionSTARTTLS (str) {
    if (str.charAt(0) !== '2') {
      if (this.options.opportunisticTLS) {
        this._log({
          level: 'info',
          tnx: 'smtp'
        }, 'Failed STARTTLS upgrade, continuing unencrypted')
        return this.emit('connect')
      }
      this._onError(new Error('Error upgrading connection with STARTTLS'), 'ETLS', str, 'STARTTLS')
      return
    }

    this._upgradeConnection((err, secured) => {
      if (err) {
        this._onError(new Error('Error initiating TLS - ' + (err.message || err)), 'ETLS', false, 'STARTTLS')
        return
      }

      this._log({
        level: 'info',
        tnx: 'smtp'
      }, 'Connection upgraded with STARTTLS')

      if (secured) {
        // restart session
        this._responseActions.push(this._actionEHLO)
        this._sendCommand('EHLO ' + this.name)
      } else {
        this.emit('connect')
      }
    })
  }

  /**
   * Handle the response for AUTH LOGIN command. We are expecting
   * '334 VXNlcm5hbWU6' (base64 for 'Username:'). Data to be sent as
   * response needs to be base64 encoded username.
   *
   * @param {String} str Message from the server
   */
  _actionAuthLoginUser (str, callback) {
    if (str !== '334 VXNlcm5hbWU6') {
      callback(this._formatError('Invalid login sequence while waiting for "334 VXNlcm5hbWU6"', 'EAUTH', str, 'AUTH LOGIN'))
      return
    }

    this._responseActions.push(str => {
      this._actionAuthLoginPass(str, callback)
    })

    this._sendCommand(new Buffer(this._auth.user + '', 'utf-8').toString('base64'))
  }

  /**
   * Handle the response for AUTH NTLM, which should be a
   * '334 <challenge string>'. See http://davenport.sourceforge.net/ntlm.html
   * We already sent the Type1 message, the challenge is a Type2 message, we
   * need to respond with a Type3 message.
   *
   * @param {String} str Message from the server
   */
  _actionAuthNtlmType1 (str, callback) {
    let challengeMatch = str.match(/^334\s+(.+)$/)
    let challengeString = ''

    if (!challengeMatch) {
      return callback(this._formatError('Invalid login sequence while waiting for server challenge string', 'EAUTH', str, 'AUTH NTLM'))
    } else {
      challengeString = challengeMatch[1]
    }

    if (!/^NTLM/i.test(challengeString)) {
      challengeString = 'NTLM ' + challengeString
    }

    let type2Message = ntlm.parseType2Message(challengeString, callback)
    if (!type2Message) {
      return
    }

    let type3Message = ntlm.createType3Message(type2Message, {
      domain: this._auth.domain || '',
      workstation: this._auth.workstation || '',
      username: this._auth.user,
      password: this._auth.pass
    })

    type3Message = type3Message.substring(5) // remove the "NTLM " prefix

    this._responseActions.push(str => {
      this._actionAuthNtlmType3(str, callback)
    })

    this._sendCommand(type3Message)
  }

  /**
   * Handle the response for AUTH CRAM-MD5 command. We are expecting
   * '334 <challenge string>'. Data to be sent as response needs to be
   * base64 decoded challenge string, MD5 hashed using the password as
   * a HMAC key, prefixed by the username and a space, and finally all
   * base64 encoded again.
   *
   * @param {String} str Message from the server
   */
  _actionAuthCramMd5 (str, callback) {
    let challengeMatch = str.match(/^334\s+(.+)$/)
    let challengeString = ''

    if (!challengeMatch) {
      return callback(this._formatError('Invalid login sequence while waiting for server challenge string', 'EAUTH', str, 'AUTH CRAM-MD5'))
    } else {
      challengeString = challengeMatch[1]
    }

    // Decode from base64
    let base64decoded = new Buffer(challengeString, 'base64').toString('ascii')
    let hmacMD5 = crypto.createHmac('md5', this._auth.pass)

    hmacMD5.update(base64decoded)

    let hexHmac = hmacMD5.digest('hex')
    let prepended = this._auth.user + ' ' + hexHmac

    this._responseActions.push(str => {
      this._actionAuthCramMd5Pass(str, callback)
    })

    this._sendCommand(new Buffer(prepended).toString('base64'))
  }

  /**
   * Handles the response to CRAM-MD5 authentication, if there's no error,
   * the user can be considered logged in. Start waiting for a message to send
   *
   * @param {String} str Message from the server
   */
  _actionAuthCramMd5Pass (str, callback) {
    if (!str.match(/^235\s+/)) {
      return callback(this._formatError('Invalid login sequence while waiting for "235"', 'EAUTH', str, 'AUTH CRAM-MD5'))
    }

    this._log({
      level: 'info',
      tnx: 'smtp',
      user: this._user,
      method: this._authMethod
    }, 'User %s authenticated', JSON.stringify(this._user))
    this.authenticated = true
    callback(null, true)
  }

  /**
   * Handles the TYPE3 response for NTLM authentication, if there's no error,
   * the user can be considered logged in. Start waiting for a message to send
   *
   * @param {String} str Message from the server
   */
  _actionAuthNtlmType3 (str, callback) {
    if (!str.match(/^235\s+/)) {
      return callback(this._formatError('Invalid login sequence while waiting for "235"', 'EAUTH', str, 'AUTH NTLM'))
    }

    this._log({
      level: 'info',
      tnx: 'smtp',
      user: this._user,
      method: this._authMethod
    }, 'User %s authenticated', JSON.stringify(this._user))
    this.authenticated = true
    callback(null, true)
  }

  /**
   * Handle the response for AUTH LOGIN command. We are expecting
   * '334 UGFzc3dvcmQ6' (base64 for 'Password:'). Data to be sent as
   * response needs to be base64 encoded password.
   *
   * @param {String} str Message from the server
   */
  _actionAuthLoginPass (str, callback) {
    if (str !== '334 UGFzc3dvcmQ6') {
      return callback(this._formatError('Invalid login sequence while waiting for "334 UGFzc3dvcmQ6"', 'EAUTH', str, 'AUTH LOGIN'))
    }

    this._responseActions.push(str => {
      this._actionAUTHComplete(str, callback)
    })

    this._sendCommand(new Buffer(this._auth.pass + '', 'utf-8').toString('base64'))
  }

  /**
   * Handles the response for authentication, if there's no error,
   * the user can be considered logged in. Start waiting for a message to send
   *
   * @param {String} str Message from the server
   */
  _actionAUTHComplete (str, isRetry, callback) {
    if (!callback && typeof isRetry === 'function') {
      callback = isRetry
      isRetry = false
    }

    if (str.substr(0, 3) === '334') {
      this._responseActions.push(str => {
        if (isRetry || !this._auth.xoauth2 || typeof this._auth.xoauth2 !== 'object') {
          this._actionAUTHComplete(str, true, callback)
        } else {
          setTimeout(() => this._handleXOauth2Token(true, callback), (Math.random() * 4000) + 1000)
        }
      })
      this._sendCommand('')
      return
    }

    if (str.charAt(0) !== '2') {
      this._log({
        level: 'info',
        tnx: 'smtp'
      }, 'User %s failed to authenticate', JSON.stringify(this._user))
      return callback(this._formatError('Invalid login', 'EAUTH', str, 'AUTH ' + this._authMethod))
    }

    this._log({
      level: 'info',
      tnx: 'smtp',
      user: this._user,
      method: this._authMethod
    }, 'User %s authenticated', JSON.stringify(this._user))
    this.authenticated = true
    callback(null, true)
  }

  /**
   * Handle response for a MAIL FROM: command
   *
   * @param {String} str Message from the server
   */
  _actionMAIL (str, callback) {
    let message, curRecipient
    if (Number(str.charAt(0)) !== 2) {
      if (this._usingSmtpUtf8 && /^550 /.test(str) && /[\x80-\uFFFF]/.test(this._envelope.from)) {
        message = 'Internationalized mailbox name not allowed'
      } else {
        message = 'Mail command failed'
      }
      return callback(this._formatError(message, 'EENVELOPE', str, 'MAIL FROM'))
    }

    if (!this._envelope.rcptQueue.length) {
      return callback(this._formatError('Can\'t send mail - no recipients defined', 'EENVELOPE', false, 'API'))
    } else {
      this._recipientQueue = []

      if (this._supportedExtensions.indexOf('PIPELINING') >= 0) {
        while (this._envelope.rcptQueue.length) {
          curRecipient = this._envelope.rcptQueue.shift()
          this._recipientQueue.push(curRecipient)
          this._responseActions.push(str => {
            this._actionRCPT(str, callback)
          })
          this._sendCommand('RCPT TO:<' + curRecipient + '>' + this._getDsnRcptToArgs())
        }
      } else {
        curRecipient = this._envelope.rcptQueue.shift()
        this._recipientQueue.push(curRecipient)
        this._responseActions.push(str => {
          this._actionRCPT(str, callback)
        })
        this._sendCommand('RCPT TO:<' + curRecipient + '>' + this._getDsnRcptToArgs())
      }
    }
  }

  /**
   * Handle response for a RCPT TO: command
   *
   * @param {String} str Message from the server
   */
  _actionRCPT (str, callback) {
    let message, err
    let curRecipient = this._recipientQueue.shift()
    if (Number(str.charAt(0)) !== 2) {
      // this is a soft error
      if (this._usingSmtpUtf8 && /^553 /.test(str) && /[\x80-\uFFFF]/.test(curRecipient)) {
        message = 'Internationalized mailbox name not allowed'
      } else {
        message = 'Recipient command failed'
      }
      this._envelope.rejected.push(curRecipient)
            // store error for the failed recipient
      err = this._formatError(message, 'EENVELOPE', str, 'RCPT TO')
      err.recipient = curRecipient
      this._envelope.rejectedErrors.push(err)
    } else {
      this._envelope.accepted.push(curRecipient)
    }

    if (!this._envelope.rcptQueue.length && !this._recipientQueue.length) {
      if (this._envelope.rejected.length < this._envelope.to.length) {
        if (this.options.envelopeOnly) {
          let response = {
            accepted: this._envelope.accepted,
            rejected: this._envelope.rejected
          }

          if (this._envelope.rejectedErrors.length) {
            response.rejectedErrors = this._envelope.rejectedErrors
          }

          return callback(null, response)
        }

        this._responseActions.push(str => {
          this._actionDATA(str, callback)
        })
        this._sendCommand('DATA')
      } else {
        err = this._formatError('Can\'t send mail - all recipients were rejected', 'EENVELOPE', str, 'RCPT TO')
        err.rejected = this._envelope.rejected
        err.rejectedErrors = this._envelope.rejectedErrors
        return callback(err)
      }
    } else if (this._envelope.rcptQueue.length) {
      curRecipient = this._envelope.rcptQueue.shift()
      this._recipientQueue.push(curRecipient)
      this._responseActions.push(str => {
        this._actionRCPT(str, callback)
      })
      this._sendCommand('RCPT TO:<' + curRecipient + '>' + this._getDsnRcptToArgs())
    }
  }

  /**
   * Handle response for a DATA command
   *
   * @param {String} str Message from the server
   */
  _actionDATA (str, callback) {
    // response should be 354 but according to this issue https://github.com/eleith/emailjs/issues/24
    // some servers might use 250 instead, so lets check for 2 or 3 as the first digit
    if ([2, 3].indexOf(Number(str.charAt(0))) < 0) {
      return callback(this._formatError('Data command failed', 'EENVELOPE', str, 'DATA'))
    }

    let response = {
      accepted: this._envelope.accepted,
      rejected: this._envelope.rejected
    }

    if (this._envelope.rejectedErrors.length) {
      response.rejectedErrors = this._envelope.rejectedErrors
    }

    callback(null, response)
  }

  /**
   * Handle response for a DATA stream when using SMTP
   * We expect a single response that defines if the sending succeeded or failed
   *
   * @param {String} str Message from the server
   */
  _actionSMTPStream (str, callback) {
    if (Number(str.charAt(0)) !== 2) {
      // Message failed
      return callback(this._formatError('Message failed', 'EMESSAGE', str, 'DATA'))
    } else {
      // Message sent succesfully
      return callback(null, str)
    }
  }

  /**
   * Handle response for a DATA stream
   * We expect a separate response for every recipient. All recipients can either
   * succeed or fail separately
   *
   * @param {String} recipient The recipient this response applies to
   * @param {Boolean} final Is this the final recipient?
   * @param {String} str Message from the server
   */
  _actionLMTPStream (recipient, final, str, callback) {
    let err
    if (Number(str.charAt(0)) !== 2) {
      // Message failed
      err = this._formatError('Message failed for recipient ' + recipient, 'EMESSAGE', str, 'DATA')
      err.recipient = recipient
      this._envelope.rejected.push(recipient)
      this._envelope.rejectedErrors.push(err)
      for (let i = 0, len = this._envelope.accepted.length; i < len; i++) {
        if (this._envelope.accepted[i] === recipient) {
          this._envelope.accepted.splice(i, 1)
        }
      }
    }
    if (final) {
      return callback(null, str)
    }
  }

  _handleXOauth2Token (isRetry, callback) {
    this._responseActions.push(str => {
      this._actionAUTHComplete(str, isRetry, callback)
    })

    if (this._auth.xoauth2 && typeof this._auth.xoauth2 === 'object') {
      this._auth.xoauth2[isRetry ? 'generateToken' : 'getToken']((err, token) => {
        if (err) {
          this._log({
            level: 'info',
            tnx: 'smtp'
          }, 'User %s failed to authenticate', JSON.stringify(this._user))
          return callback(this._formatError(err, 'EAUTH', false, 'AUTH XOAUTH2'))
        }
        this._sendCommand('AUTH XOAUTH2 ' + token)
      })
    } else {
      this._sendCommand('AUTH XOAUTH2 ' + this._buildXOAuth2Token(this._auth.user, this._auth.xoauth2))
    }
  }

  /**
   * Builds a login token for XOAUTH2 authentication command
   *
   * @param {String} user E-mail address of the user
   * @param {String} token Valid access token for the user
   * @return {String} Base64 formatted login token
   */
  _buildXOAuth2Token (user, token) {
    let authData = [
      'user=' + (user || ''),
      'auth=Bearer ' + token,
      '',
      ''
    ]
    return new Buffer(authData.join('\x01')).toString('base64')
  }

  _getHostname () {
    // defaul hostname is machine hostname or [IP]
    let defaultHostname = os.hostname() || ''

    // ignore if not FQDN
    if (defaultHostname.indexOf('.') < 0) {
      defaultHostname = '[127.0.0.1]'
    }

    // IP should be enclosed in []
    if (defaultHostname.match(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/)) {
      defaultHostname = '[' + defaultHostname + ']'
    }

    return defaultHostname
  }

  _log (data, message, ...args) {
    let level = 'debug'
    let entry = {
      component: this.component,
      sid: this.id
    }
    if (typeof data !== 'object' || !data) {
      level = (data || '').toString().toLowerCase().trim() || level
    } else {
      Object.keys(data || {}).forEach(key => {
        if (key === 'level') {
          level = (data[key] || '').toString().toLowerCase().trim() || level
        } else {
          entry[key] = data[key]
        }
      })
    }

    if (typeof this.logger[level] !== 'function') {
      level = 'debug'
    }

    if (this.structuredLogger) {
      this.logger[level](entry, message, ...args)
    } else {
      let prefix = ''
      if (entry.tnx === 'server') {
        prefix = 'S: '
      } else if (entry.tnx === 'client') {
        prefix = 'C: '
      }
      this.logger[level](message.replace(/^/mg, '[' + entry.sid + '] ' + prefix), ...args)
    }
  }
}

module.exports = SMTPConnection
