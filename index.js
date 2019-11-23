const { remote } = require('electron')
const FileSystem = require('original-fs')
const Utils = require('util')
const request = require('request')
const progress = require('request-progress')
const admZip = require('adm-zip')
const fs = require('fs')
const crypto = require('crypto')

// Yes, it's weird, but we need the trailing slash after the .asar
// so we can read paths "inside" it, e.g. the package.json, where we look
// for our current version
const AppPath = remote.app.getAppPath() + '/'
const AppPathFolder = AppPath.slice(0, AppPath.indexOf('app.asar'))
const AppAsar = AppPath.slice(0, -1)
const WindowsUpdater =
  AppPath.slice(0, AppPath.indexOf('resources')) + 'updater.exe'

const errors = [
  'version_not_specified',
  'cannot_connect_to_api',
  'no_update_available',
  'api_response_not_valid',
  'update_file_not_found',
  'failed_to_download_update',
  'failed_to_apply_update'
]

/**
 * */
var Updater = {
  /**
   * The setup
   * */
  setup: {
    api: null,
    token: null,
    server: true,
    logFile: 'updater-log.txt',
    requestOptions: {},
    callback: false,
    progresscallback: false,
    unzipCallback : false,
    debug: false
  },

  /**
   * The new update information
   * */
  update: {
    last: null,
    source: null,
    file: null,
    sha1: null
  },

  /**
   * Init the module
   * */
  init: function (setup) {
    this.setup = Utils._extend(this.setup, setup)

    this.log('AppPath: ' + AppPath)
    this.log('AppPathFolder: ' + AppPathFolder)
  },

  /**
   * Sha1
   * */
  sha1: function(buffer) {
    var fsHash = crypto.createHash('sha1');
    fsHash.update(buffer);
    var sha1 = fsHash.digest('hex');
    return sha1;
  },

  /**
   * Logging
   * */
  log: function (line) {
    // Log it
    if(this.setup.debug) {
      console.log('Updater: ', line)
    }

    // Put it into a file
    if (this.setup.logFile) {
      if(this.setup.debug) {
        console.log('%s + %s + %s', AppPathFolder, this.setup.logFile, line)
      }
      FileSystem.appendFileSync(AppPathFolder + this.setup.logFile, line + '\n')
    }
  },

  /**
   * Triggers the callback you set to receive the result of the update
   * */
  end: function (error, body) {
    if (typeof this.setup.callback !== 'function') return false
    this.setup.callback.call(
      this,
      error != 'undefined' ? errors[error] : false,
      this.update.last,
      body
    )
  },

  /**
   * Make the check for the update
   * */
  process : function(onlineInfo,callback)
  {
    if (callback) {
      this.setup.callback = callback
    }

    // Get the current version
    try{
      var packageInfo = JSON.parse(fs.readFileSync(AppPath + 'package.json'))
    } catch(e) {
      console.error(e)
    }

    this.log(packageInfo.version)

    // If the version property not specified
    if (!packageInfo.version) {
      this.log(
        'The "version" property not specified inside the application package.json'
      )
      this.end(0)

      return false
    }

    try {
      let response = {}

      if (Updater.setup.server) {
        response = onlineInfo
      } else {
        response = { last: onlineInfo.version }
        if (onlineInfo.version > packageInfo.version) {
          response.source = onlineInfo.zip
        }
        if(onlineInfo.sha1) {
          response.sha1 = onlineInfo.sha1
        }
      }

      // If the "last" property is not defined
      if (!response.last) {
        throw false
      }

      // Update available
      if (response.source) {
        Updater.log('Update available: ' + response.last)

        // Store the response
        Updater.update = response

        // Ask user for confirmation
        Updater.end(undefined, onlineInfo)
      } else {
        Updater.log('No updates available')
        Updater.end(2)

        return false
      }
    } catch (error) {
      Updater.log(error)
      Updater.log('API response is not valid')
      Updater.end(3)
    }
  },

  /**
   * Download the update file
   * */
  download: function (extractPath,callback) {
    if (callback) {
      this.setup.callback = callback
    }
    if (!extractPath){
      extractPath = AppPathFolder;
    }
    var url = this.update.source, fileName = 'update.asar', update_sha1 = this.update.sha1

    this.log('Downloading ' + url)

    progress(
      request(
        {
          uri: url,
          encoding: null
        },
        function (error, response, body) {
          if (error) {
            return console.error('err')
          }
          var updateFile = AppPathFolder + "/" + fileName
          if (response.headers['content-type'].indexOf('zip') > -1 || url.endsWith('.zip')) {
            Updater.log('ZipFilePath: ' + AppPathFolder)
            try {
              process.noAsar = true;
              const zip = new admZip(body)
              zip.extractAllTo(extractPath, true, function(file){
                if(Updater.setup.unzipCallback) { //callback to main function
                  Updater.setup.unzipCallback(file);
                }
              });
              // Store the update file path
              Updater.update.file = updateFile
              Updater.log('Updater.update.file: ' + updateFile)
              // Success
              Updater.log('Update Zip downloaded: ' + AppPathFolder)
              // Apply the update
              if(update_sha1) {
                try{
                  //var buffer = FileSystem.readFileSync(updateFile);
                  var sha1 = Updater.sha1(body)
                  if(sha1 !== update_sha1) {
                    Updater.log('Upload failed! Sha1 code mismatch.')
                    Updater.end(5)
                    return false
                  }
                } catch(e) {
                  Updater.log('sha1_error')
                }
              }
              process.noAsar = false;
              if(Updater.update.type && Updater.update.type.includes("app")){ //this is app update
                if (process.platform === 'darwin') {
                  Updater.apply()
                } else {
                  Updater.mvOrMove()
                }
              }
            } catch (error) {
              Updater.log('unzip error: ' + error)
            }
          }
        }
      ),
      {
        throttle: 500 // Throttle the progress event to 500ms, defaults to 1000ms
        // delay: 1000,                       // Only start to emit after 1000ms delay, defaults to 0ms
        // lengthHeader: 'x-transfer-length'  // Length header to use, defaults to content-length
      }
    )
      .on('progress', function (state) {
        // The state is an object that looks like this:
        // {
        //     percent: 0.5,               // Overall percent (between 0 to 1)
        //     speed: 554732,              // The download speed in bytes/sec
        //     size: {
        //         total: 90044871,        // The total payload size in bytes
        //         transferred: 27610959   // The transferred payload size in bytes
        //     },
        //     time: {
        //         elapsed: 36.235,        // The total elapsed seconds since the start (3 decimals)
        //         remaining: 81.403       // The remaining seconds to finish (3 decimals)
        //     }
        // }
        if (Updater.setup.progresscallback) {
          Updater.setup.progresscallback(state)
        }
      })
      .on('error', function (err) {
        // Do something with err
        Updater.log('Do something with err', err)
      })
      .on('end', function (d) {
        // Do something after request finishes
        Updater.log('Do something after request finishes', d)
      })
  },

  progress: function (callback) {
    if (callback) {
      this.setup.progresscallback = callback
    }
  },

  registerUnzipCallback : function(callback) {
    if (callback) {
      this.setup.unzipCallback = callback
    }
  },
  /**
   * Apply the update, remove app.asar and rename update.zip to app.asar
   * */
  apply: function () {
    try {
      this.log('Going to unlink: ' + AppPath.slice(0, -1))

      FileSystem.unlink(AppPath.slice(0, -1), function (err) {
        if (err) {
          Updater.log("Couldn't unlink: " + AppPath.slice(0, -1))
          return console.error(err)
        }
        Updater.log('Asar deleted successfully.')
      })
    } catch (error) {
      this.log('Delete error: ' + error)

      // Failure
      this.end(6)
    }

    try {
      this.log(
        'Going to rename: ' + this.update.file + ' to: ' + AppPath.slice(0, -1)
      )
      FileSystem.rename(this.update.file, AppPath.slice(0, -1), function (err) {
        if (err) {
          Updater.log(
            "Couldn't rename: " +
              Updater.update.file +
              ' to: ' +
              AppPath.slice(0, -1)
          )
          return console.error(err)
        }
        Updater.log('Update applied.')
      })

      this.log('End of update.')
      // Success
      this.end()
    } catch (error) {
      this.log('Rename error: ' + error)

      // Failure
      this.end(6)
    }
  },

  // app.asar is always EBUSY on Windows, so we need to try another
  // way of replacing it. This should get called after the main Electron
  // process has quit. Win32 calls 'move' and other platforms call 'mv'
  mvOrMove: async function (child) {
    var updateAsar = AppPathFolder + 'update.asar'
    var appAsar = AppPathFolder + 'app.asar'
    var winArgs = ''

    Updater.log('Checking for ' + updateAsar)

    try {
      FileSystem.accessSync(updateAsar)
      try {
        Updater.log(
          'Going to shell out to move: ' + updateAsar + ' to: ' + AppAsar
        )

        if (process.platform === 'win32') {
          Updater.log(
            'Going to start the windows updater:' +
              WindowsUpdater +
              ' ' +
              updateAsar +
              ' ' +
              appAsar
          )
          fs.writeFileSync(
            WindowsUpdater,
            fs.readFileSync(
              `${AppPathFolder}app.asar/node_modules/${require('./package.json').name}/updater.exe`
            )
          )

          // JSON.stringify() calls mean we're correctly quoting paths with spaces
          winArgs = `${JSON.stringify(WindowsUpdater)} ${JSON.stringify(updateAsar)} ${JSON.stringify(appAsar)}`
          Updater.log(winArgs)
          // and the windowsVerbatimArguments options argument, in combination with the /s switch, stops windows stripping quotes from our commandline

          // This doesn't work:
          const { spawn } = require('child_process')
          // spawn(`${JSON.stringify(WindowsUpdater)}`,[`${JSON.stringify(updateAsar)}`,`${JSON.stringify(appAsar)}`], {detached: true, windowsVerbatimArguments: true, stdio: 'ignore'});
          // so we have to spawn a cmd shell, which then runs the updater, and leaves a visible window whilst running
          const child = spawn('cmd', ['/s', '/c', '"' + winArgs + '"'], {
            detached: true,
            windowsVerbatimArguments: true,
            stdio: 'ignore'
          })
		  child.on('exit', code => {
			console.log(`Exit code is: ${code}`);
			Updater.end();
		  });
          //remote.app.quit()
          //finish update
          
        } else {
          // here's how we'd do this on Mac/Linux, but on Mac at least, the .asar isn't marked as busy, so the update process above
          // is able to overwrite it.
          //
          child.spawn('bash', ['-c', ['cd ' + JSON.stringify(AppPathFolder), 'mv -f update.asar app.asar'].join(' && ')], {detached: true});
   		  child.on('exit',code=>{
   		  	console.log(`Exit code is: ${code}`);
			Updater.end();
		  })
        }
      } catch (error) {
      	console.log(error);
        Updater.log('Shelling out to move failed: ' + error)
      }
    } catch (error) {
      console.log(error);
      Updater.log("Couldn't see an " + updateAsar + ' error was: ' + error)
    }
  }
}

module.exports = Updater
