'use strict'

/*
 * nodemailer-shared/lib/shared.js
 *
 * Copyright (c) 2016 Andris Reinman
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
*/

const util = require('util')

/**
 * Returns a bunyan-compatible logger interface. Uses either provided logger or
 * creates a default console logger
 *
 * @param {Object} [options] Options object that might include 'logger' value
 * @return {Object} bunyan compatible logger
 */
module.exports.getLogger = options => {
  options = options || {}

  if (!options.logger) {
    // use vanity logger
    return {
      info () {},
      debug () {},
      error () {}
    }
  }

  if (options.logger === true) {
    // create console logger
    return createDefaultLogger()
  }

  // return whatever was passed
  return options.logger
}

/**
 * Generates a bunyan-like logger that prints to console
 *
 * @returns {Object} Bunyan logger instance
 */
function createDefaultLogger () {
  let logger = {
    _print (/* level, message */) {
      let args = Array.prototype.slice.call(arguments)
      let level = args.shift()
      let message

      if (args.length > 1) {
        message = util.format(...args)
      } else {
        message = args.shift()
      }

      console.log(
        '[%s] %s: %s', // eslint-disable-line no-console
        new Date().toISOString().substr(0, 19).replace(/T/, ' '),
        level.toUpperCase(),
        message
      )
    }
  }

  logger.info = logger._print.bind(null, 'info')
  logger.debug = logger._print.bind(null, 'debug')
  logger.error = logger._print.bind(null, 'error')

  return logger
}
