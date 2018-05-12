#!/usr/bin/env node

var program = require('commander');
var fs = require('fs');
var path = require('path');
var jsyaml = require('js-yaml');
var ZSchema = require('z-schema');
var validator = new ZSchema({
  ignoreUnresolvableReferences: true
});
var utils = require("../src/lib/utils.js");
var config = require('../src/configurations'),
  logger = config.logger;
var shell = require('shelljs');
var zipdir = require('zip-dir');
var touch = require("touch");
var beautify = require('js-beautify').js;
const semver = require('semver')

var schemaV3 = fs.readFileSync(path.join(__dirname, './schemas/openapi-3.0.json'), 'utf8');
schemaV3 = JSON.parse(schemaV3);

/**
 * Generates a valid value for package.json's name property:
 *    -All lowercase
 *    -One word, no spaces
 *    -Dashes and underscores allowed.
 * @param {object} title - Value of oasDoc.info.title.
 */
function getValidName(title) {
  return title.toLowerCase().replace(/[ ]/g, '-').replace(/[^0-9a-z-_]/g, "");
}

/**
 * Checks that version property matches X.X.X or tries to modify it to match it. In case it is not possible returns 1.0.0
 * @param {object} version - Value of oasDoc.info.version.
 */
function checkVersion(version) {
  var validVersion = semver.valid(semver.coerce(version));
  if (validVersion == null) {
    return "1.0.0";
  } else {
    return validVersion;
  }
}


program
  .arguments('<file>')
  .option('-n, --proyectName <proyectName>', 'Name for the generated folder')
  .option('-z, --delete', 'Indicate whether the generated folder must be deleted after compression')
  .action(function(file) {
    try {
      try {
        var spec = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
        var oasDoc = jsyaml.safeLoad(spec);
        logger.info('Input oas-doc %s: %s', file, oasDoc);
      } catch (err) {
        logger.error("" + err);
        process.exit();
      }
      var err = validator.validate(oasDoc, schemaV3);
      if (err == false) {
        logger.error('oasDoc is not valid: ' + err.getLastErrors());
        process.exit();
      }
      var proyectName = "nodejs-server-generated";
      if (program.proyectName) { // TODO: doesn't work!!! why does delete work and not proyectName?
        proyectName = program.proyectName;
        if (!/^[a-zA-Z0-9-_]+$/.test(proyectName)) {
          logger.error("Provided name ( + " + proyectName + ") must not have spaces, slashes or : * ? < > | ");
          process.exit();
        } else {
          logger.debug("Valid provided proyect name: " + proyectName);
        }
      }

      shell.exec('mkdir ' + proyectName);
      shell.cd(proyectName);
      shell.cp(__dirname + '/auxiliary/README.md', './README.md');

      shell.exec('mkdir .oas-generator && echo 1.0.0 > .oas-generator/VERSION');

      shell.exec('mkdir api');
      shell.cp('../' + file, './api/oas-doc.yaml');

      shell.exec('mkdir utils');
      shell.cp(__dirname + '/auxiliary/writer.js', './utils/writer.js');

      shell.exec('mkdir controllers');
      var paths = oasDoc.paths;
      var opId;
      var controllerName;
      var controller_files = [];
      for (path in paths) {
        for (var method in paths[path]) {
          if (paths[path][method].operationId != undefined) {
            opId = utils.normalize(paths[path][method].operationId);
          } else {
            opId = utils.normalize(utils.generateOperationId(method, path));
            logger.debug("Oas-doc does not have opearationId property for " + method.toUpperCase() + " - " + path + " -> operationId name autogenerated: " + opId);
          }
          if (paths[path][method]['x-router-controller'] != undefined) {
            controllerName = paths[path][method]['x-router-controller'];
          } else if (paths[path][method]['x-swagger-router-controller'] != undefined) {
            controllerName = paths[path][method]['x-swagger-router-controller'];
          } else {
            controllerName = utils.getBasePath(utils.getExpressVersion(path)) + "Controller";
            logger.debug("Oas-doc does not have routing property for " + method.toUpperCase() + " - " + path + " -> controller name autogenerated: " + utils.normalize_controllerName(controllerName));
          }
          controllerName = utils.normalize_controllerName(controllerName);
          logger.debug("Write: " + opId);
          if (!controller_files.includes(controllerName)) {
            controller_files.push(controllerName);
            controller_files.push(controllerName + "Service");
            var header = "'use strict' \n\nvar " + controllerName + " = require('./" + controllerName + "Service');\n\n";
            fs.appendFileSync(process.cwd() + '/controllers/' + controllerName + ".js", header);
            fs.appendFileSync(process.cwd() + '/controllers/' + controllerName + "Service.js", "'use strict'\n\n");
          }
          var function_string = "module.exports." + opId + " = function " + opId + " (req, res, next) {\n" + controllerName + "." + opId + "(req.swagger.params, res, next);\n};\n\n";
          var function_string_service = "module.exports." + opId + " = function " + opId + " (req, res, next) {\nres.send({message: 'This is the raw controller for " + opId + "' });\n};\n\n";
          fs.appendFileSync(process.cwd() + '/controllers/' + controllerName + ".js", function_string);
          fs.appendFileSync(process.cwd() + '/controllers/' + controllerName + "Service.js", function_string_service);
        }
      }

      for (var i = 0; i < controller_files.length; i++) {
        logger.debug("Beautify file " + controller_files[i]);
        var data = fs.readFileSync(process.cwd() + '/controllers/' + controller_files[i] + ".js", 'utf8');
        fs.writeFileSync(process.cwd() + '/controllers/' + controller_files[i] + ".js", beautify(data, {
          indent_size: 2,
          space_in_empty_paren: true
        }));
      }

      touch.sync('.oas-generator-ignore');
      shell.cp(__dirname + '/auxiliary/index.js', './index.js');

      var package_raw = {
        "name": getValidName(oasDoc.info.title),
        "version": checkVersion(oasDoc.info.version),
        "description": "No description provided (generated by OAS Codegen)",
        "main": "index.js",
        "scripts": {
          "prestart": "npm install",
          "start": "node index.js"
        },
        "keywords": [
          "OAI"
        ],
        "license": "Unlicense",
        "private": true,
        "dependencies": {
          "express": "^4.16.3",
          "js-yaml": "^3.3.0",
          //"oas-tools": "1.0.0"
        }
      };

      fs.writeFileSync(process.cwd() + '/' + 'package.json', beautify(JSON.stringify(package_raw), {
        indent_size: 2,
        space_in_empty_paren: true
      }));

      shell.cd('..');

      zipdir('./' + proyectName, {
        saveTo: proyectName + '.zip'
      }, function(err, buffer) {
        if (err) {
          logger.error('Compressor error: ', err);
        } else {
          logger.debug('---< NodeJS project ZIP generated! >---');
          if (program.delete) { //option -z used means delete generated folder after compression
            shell.rm('-r', proyectName);
          }
        }
      });
    } catch (err) {
      logger.error(err);
    }
  })
  .parse(process.argv);
