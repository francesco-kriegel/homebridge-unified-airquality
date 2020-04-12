"use strict";
var Service, Characteristic, CustomCharacteristic, Accessory, FakeGatoHistoryService, homebridgeUserStoragePath;

const DataCache     = require("./lib/data_cache");
const http          = require("http");
const moment        = require("moment");
const request       = require("request");
const bme280_sensor = require("bme280-sensor");
const debug         = require("debug")("BME280");
const logger        = require("mcuiot-logger").logger;
const os            = require("os");
const hostname      = os.hostname();
const fs            = require("fs");

module.exports = function(homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  CustomCharacteristic = require("./lib/custom_characteristics")(Characteristic);
  Accessory = homebridge.hap.Accessory;
  FakeGatoHistoryService = require("fakegato-history")(homebridge);
  homebridgeUserStoragePath = homebridge.user.storagePath();

  homebridge.registerAccessory(
    "homebridge-unified-airquality",
    "unified-airquality",
    UnifiedAirQualityAccessory
  );
};

function UnifiedAirQualityAccessory(log, config) {
  const instance = this;
  instance.category = Accessory.Categories.SENSOR;
  instance.log = log;
  instance.dataCache = null;

  instance.displayName = config["name"] || "UnifiedAirQualityAccessory";
  instance.serialNumber = config["serial_number"] || "UAQ161803398875";
  instance.updateIntervalSeconds = config["update_interval_seconds"] || 120;
  instance.updateHistorySeconds = config["update_history_seconds"] || 600;
  instance.updateHistoryFrequency = Math.max(1, Math.round(instance.updateHistorySeconds / instance.updateIntervalSeconds));
  instance.updateHistoryCounter = 0;
  instance.historyPath = config["history_path"] || homebridgeUserStoragePath;
  instance.historyFilename = config["history_filename"];
  instance.sources = config["sources"] || [];
  instance.services = config["services"] || [];

  instance.log.debug("Update interval:", instance.updateIntervalSeconds, "s");

  instance.informationService = new Service.AccessoryInformation();
  instance.informationService.setCharacteristic(
    Characteristic.Manufacturer,
    "Francesco Kriegel"
  );
  instance.informationService.setCharacteristic(
    Characteristic.Model,
    "Unified Air Quality Accessory"
  );
  instance.informationService.setCharacteristic(
    Characteristic.SerialNumber,
    instance.serialNumber
  );
  instance.informationService.setCharacteristic(
    Characteristic.FirmwareRevision,
    "1.0.0"
  );

  if (!!instance.services["temperature"]) {
    instance.temperatureService = new Service.TemperatureSensor("Temperature " + instance.services["temperature"]["name"]);
    instance.temperatureService
      .getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({
        format: Characteristic.Formats.FLOAT,
        unit: Characteristic.Units.CELSIUS,
        maxValue: 100,
        minValue: -100,
        minStep: 0.1,
        perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
      });
    instance.temperatureService.addOptionalCharacteristic(Characteristic.StatusFault);
    if (!!instance.services["temperature"]["pressure"]) {
      instance.temperatureService.addOptionalCharacteristic(CustomCharacteristic.AirPressure);
    }
  }
  if (!!instance.services["humidity"]) {
    instance.humidityService = new Service.HumiditySensor("Humidity " + instance.services["humidity"]["name"]);
    instance.humidityService.addOptionalCharacteristic(Characteristic.StatusFault);
  }
  if (!!instance.services["temperature"] || !!instance.services["humidity"]) {
    instance.log.debug("Creating FakeGatoHistoryService with options " + JSON.stringify(instance.historyOptions));
    // "room" instead of "weather" does not work, and neither can we use two history services
    // storing history does not work
    // { size: 4032, minutes: 1, storage: "fs",  filename: "UAQ161803398875_persist.json", disableTimer: false }
    instance.loggingService = new FakeGatoHistoryService("weather", this, { size: 525600, disableTimer: true });
    // homebridge.globalFakeGatoTimer.start();
  }
  if (!!instance.services["airquality"]) {
    instance.airQualityService = new Service.AirQualitySensor("Air Quality " + instance.services["airquality"]["name"]);
    instance.airQualityService.addOptionalCharacteristic(CustomCharacteristic.EveAirQuality)
    instance.airQualityService.addOptionalCharacteristic(Characteristic.StatusFault);
    if (!!instance.services["airquality"]["co"]) {
      instance.airQualityService.addOptionalCharacteristic(Characteristic.CarbonMonoxideLevel);
    }
    if (!!instance.services["airquality"]["co2"]) {
      instance.airQualityService.addOptionalCharacteristic(Characteristic.CarbonDioxideLevel);
    }
    if (!!instance.services["airquality"]["no2"]) {
      instance.airQualityService.addOptionalCharacteristic(Characteristic.NitrogenDioxideDensity);
    }
    if (!!instance.services["airquality"]["o3"]) {
      instance.airQualityService.addOptionalCharacteristic(Characteristic.OzoneDensity);
    }
    if (!!instance.services["airquality"]["pm2.5"]) {
      instance.airQualityService.addOptionalCharacteristic(Characteristic.PM2_5Density);
    }
    if (!!instance.services["airquality"]["pm10"]) {
      instance.airQualityService.addOptionalCharacteristic(Characteristic.PM10Density);
    }
    if (!!instance.services["airquality"]["so2"]) {
      instance.airQualityService.addOptionalCharacteristic(Characteristic.SulphurDioxideDensity);
    }
    if (!!instance.services["airquality"]["voc"]) {
      instance.airQualityService.addOptionalCharacteristic(Characteristic.VOCDensity);
    }
    if (!!instance.services["temperature"] || !!instance.services["humidity"]) {
      instance.airQualityService.isPrimaryService = true;
      instance.airQualityService.linkedServices =
        [instance.humidityService, instance.temperatureService].filter(function(s) {
          return s !== undefined;
        });
    }
  }

  instance.bme280sensors = {};
  instance.dataCaches = {};
  instance.data = {};
  instance.error = false;

  const initLuftdatenInfo = function(source, callback) {
    instance.dataCaches[source["id"]] = new DataCache();
    callback();
  }

  const pollLuftdatenInfo = function(source, callback) {
    // const url = "http://api.luftdaten.info/v1/sensor/" + source["sensor"] + "/";
    const url = "http://data.sensor.community/airrohr/v1/sensor/" + source["sensor"] + "/";
    const dataCache = instance.dataCaches[source["id"]];
    dataCache.updateFromLuftdatenAPI(url, url, function(error) {
      if (error) {
        instance.log.error(`Could not get sensor data: ${error}`);
        instance.error = true;
      } else {
        for (let i in source["keys"]) {
          var key = source["keys"][i];
          switch (key) {
            case "temperature":
              if (!!dataCache.temperature) {
                instance.data[source["id"]]["temperature"] = dataCache.temperature;
              } else {
                instance.log.error("null value for " + key);
              }
              break;
            case "humidity":
              if (!!dataCache.humidity) {
                instance.data[source["id"]]["humidity"] = dataCache.humidity;
              } else {
                instance.log.error("null value for " + key);
              }
              break;
            case "pressure":
              if (!!dataCache.pressure) {
                instance.data[source["id"]]["pressure"] = dataCache.pressure;
              } else {
                instance.log.error("null value for " + key);
              }
              break;
            case "pm2.5":
              if (dataCache.pm25) {
                instance.data[source["id"]]["pm2.5"] = dataCache.pm25;
              } else {
                instance.log.error("null value for " + key);
              }
              break;
            case "pm10":
              if (dataCache.pm10) {
                instance.data[source["id"]]["pm10"] = dataCache.pm10;
              } else {
                instance.log.error("null value for " + key);
              }
              break;
            default:
              instance.log.error("Unknown source key " + key);
              break;
          }
        }
      }
      callback();
    }.bind(instance));
  };

  const initWaqiInfo = function(source, callback) {
    callback();
  }

  const pollWaqiInfo = function(source, callback) {
    const url = "http://api.waqi.info/feed/" + source["city"] + "/?token=" + source["token"];
    request({
      url: url,
      json: true
    }, function (error, response, observations) {
      if (!error && response.statusCode === 200 && observations.status == "ok" && observations.data.idx != "-1") {
        // instance.log.debug("AirNow air quality AQI is: %s", observations.data.aqi);
        for (let i in source["keys"]) {
          var key = source["keys"][i];
          switch (key) {
            case "temperature":
              if (observations.data.iaqi.hasOwnProperty('t')) {
                instance.data[source["id"]]["temperature"] = parseFloat(observations.data.iaqi.t.v);
              } else {
                instance.log.error("null value for " + key);
              }
              break;
            case "pressure":
              if (observations.data.iaqi.hasOwnProperty('p')) {
                instance.data[source["id"]]["pressure"] = parseFloat(observations.data.iaqi.p.v);
              } else {
                instance.log.error("null value for " + key);
              }
              break;
            case "co":
              if (observations.data.iaqi.hasOwnProperty('co')) {
                instance.data[source["id"]]["co"] = parseFloat(observations.data.iaqi.co.v);
              } else {
                instance.log.error("null value for " + key);
              }
              break;
            case "no2":
              if (observations.data.iaqi.hasOwnProperty('no2')) {
                instance.data[source["id"]]["no2"] = parseFloat(observations.data.iaqi.no2.v);
              } else {
                instance.log.error("null value for " + key);
              }
              break;
            case "o3":
              if (observations.data.iaqi.hasOwnProperty('o3')) {
                instance.data[source["id"]]["o3"] = parseFloat(observations.data.iaqi.o3.v);
              } else {
                instance.log.error("null value for " + key);
              }
              break;
            case "pm2.5":
              if (observations.data.iaqi.hasOwnProperty('pm25')) {
                instance.data[source["id"]]["pm2.5"] =  parseFloat(observations.data.iaqi.pm25.v);
              } else {
                instance.log.error("null value for " + key);
              }
              break;
            case "pm10":
              if (observations.data.iaqi.hasOwnProperty('pm10')) {
                instance.data[source["id"]]["pm10"] = parseFloat(observations.data.iaqi.pm10.v);
              } else {
                instance.log.error("null value for " + key);
              }
              break;
            case "so2":
              if (observations.data.iaqi.hasOwnProperty('so2')) {
                instance.data[source["id"]]["so2"] = parseFloat(observations.data.iaqi.so2.v);
              } else {
                instance.log.error("null value for " + key);
              }
              break;
            default:
              instance.log.error("Unknown source key " + key);
              break;
          }
        }
      } else if (!error && observations.status == "error") {
        instance.log.error("Observation Error - %s from %s.", observations.data, instance.provider);
        instance.error = true;
      } else if (!error && observations.status == "ok" && observations.data.idx == "-1") {
        instance.log.error("Configuration Error - Invalid City Code from %s.", instance.provider);
        instance.error = true;
      } else {
        instance.log.error("Network or Unknown Error from %s.", instance.provider);
        instance.error = true;
      }
      callback();
    }.bind(instance));
  };

  const initBme280 = function(source, callback) {
    instance.log.debug("Initializing BME280 sensor " + JSON.stringify(source));
    try {
      instance.bme280sensors[source["id"]] = new bme280_sensor({
        "i2cBusNo": parseInt(source["i2cBusNo"]),
        "i2cAddress": parseInt(source["i2cAddress"])
      });
      instance.bme280sensors[source["id"]].init()
        .then(result => { callback(); })
        .catch(error => {
          instance.log.error("Cannot initialize BME280 " + JSON.stringify(source));
          instance.log.error(error);
          callback();
        })
    } catch (error) {
      instance.log.error("Cannot initialize BME280 " + JSON.stringify(source));
      instance.log.error(error);
      callback();
    }
  }

  const pollBme280 = function(source, callback) {
    instance.bme280sensors[source["id"]].readSensorData().then((sensorData) => {
      instance.log.debug("BME280 sensor " + source["id"] + " provided the following data " + JSON.stringify(sensorData));
      source["keys"].forEach(function(key) {
        switch (key) {
          case "temperature":
            instance.data[source["id"]]["temperature"] = sensorData.temperature_C;
            break;
          case "humidity":
            instance.data[source["id"]]["humidity"] = sensorData.humidity;
            break;
          case "pressure":
            instance.data[source["id"]]["pressure"] = sensorData.pressure_hPa;
            break;
          default:
            instance.log.error("Unknown source key " + key);
            break;
        }
      });
      callback();
    }).catch((error) => {
      instance.log.error(error);
      instance.error = true;
      callback();
    });
  }

  const updateData = function(callback) {

    instance.log.debug("updating data...");

    const offset = function(source, callback) {
      instance.log.debug("offsetting " + JSON.stringify(source));
      if (!!source["offsets"]) {
        Object.keys(source["offsets"]).forEach(function(key, index) {
          if (!!instance.data[source["id"]][key]) {
            instance.data[source["id"]][key] += source["offsets"][key];
          }
        });
      }
      callback();
    }

    const poll = function(source, callback) {
      instance.log.debug("polling " + JSON.stringify(source));
      /*if (!instance.data[source["id"]]) {
        instance.data[source["id"]] = {};
      }*/
      switch (source["provider"]) {
        case "luftdaten.info":
          pollLuftdatenInfo(source, () => offset(source, callback));
          break;
        case "waqi.info":
          pollWaqiInfo(source, () => offset(source, callback));
          break;
        case "bme280":
          pollBme280(source, () => offset(source, callback));
          break;
        default:
          instance.log.error("Unknown provider " + source["provider"]);
          callback();
          break;
      }
    };

    const next = function(remainingSources) {
      if (!remainingSources.length) {
        instance.log.debug(JSON.stringify(instance.data));
        callback();
      } else {
        const [source, ...nextSources] = remainingSources;
        poll(source, () => next(nextSources));
      }
    };

    next(instance.sources);

  }.bind(this);

  const updateServices = function(callback) {

    instance.log.debug("updating services...");

    if (instance.error) {
      if (!!instance.services["temperature"]) { instance.temperatureService.setCharacteristic(Characteristic.StatusFault, 1); }
      if (!!instance.services["humidity"]) { instance.humidityService.setCharacteristic(Characteristic.StatusFault, 1); }
      if (!!instance.services["airquality"]) { instance.airQualityService.setCharacteristic(Characteristic.StatusFault, 1); }
    } else {
      if (!!instance.services["temperature"]) { instance.temperatureService.setCharacteristic(Characteristic.StatusFault, 0); }
      if (!!instance.services["humidity"]) { instance.humidityService.setCharacteristic(Characteristic.StatusFault, 0); }
      if (!!instance.services["airquality"]) { instance.airQualityService.setCharacteristic(Characteristic.StatusFault, 0); }
    }

    const getValue = function(service, key) {
      var value;
      if (Object.prototype.toString.call(instance.services[service][key]) === "[object String]") {
        if (!!instance.data[instance.services[service][key]] && !!instance.data[instance.services[service][key]][key]) {
          value = parseFloat(instance.data[instance.services[service][key]][key]);
        } else {
          value = null;
        }
      } else {
        var values = [];
        instance.services[service][key]["sources"].forEach(function(id) {
          if (!!instance.data[id] && !!instance.data[id][key]) {
            values.push(parseFloat(instance.data[id][key]));
          }
        });
        if (values.length > 0) {
          switch (instance.services[service][key]["aggregate"]) {
            case "minimum":
              value = Math.min(...values);
              break;
            case "maximum":
              value = Math.max(...values);
              break;
            case "average":
              value = values.reduce(function(x, y) { return x + y; }) / values.length;
              break;
            default:
             instance.log.error("unknown aggregate function " + instance.services[service][key]["aggregate"]);
             break;
          }
        } else {
          value = null;
        }
      }
      return value;
    }.bind(this);

    if (!!instance.services["temperature"]) {
      instance.temperature = getValue("temperature", "temperature");
      instance.log.info("Temperature:  ", instance.temperature, "°C");
      instance.temperatureService.setCharacteristic(
        Characteristic.CurrentTemperature,
        instance.temperature
      );
      if (!!instance.services["temperature"]["pressure"]) {
        instance.pressure = getValue("temperature", "pressure");
        instance.log.info("Pressure:     ", instance.pressure, "hPa");
        instance.temperatureService.setCharacteristic(
          CustomCharacteristic.AirPressure,
          Math.round(instance.pressure)
        );
      }
    }
    if (!!instance.services["humidity"]) {
      instance.humidity = getValue("humidity", "humidity");
      instance.log.info("Humidity:     ", instance.humidity, "%");
      instance.humidityService.setCharacteristic(
        Characteristic.CurrentRelativeHumidity,
        Math.round(instance.humidity)
      );
    }
    if (!!instance.services["airquality"]) {
      if (!!instance.services["airquality"]["co"]) {
        instance.co = getValue("airquality", "co");
        instance.log.info("CO Density:   ", instance.co, "µg/m³");
        instance.airQualityService.setCharacteristic(
          Characteristic.CarbonMonoxideLevel,
          Math.round(instance.co)
        );
      }
      if (!!instance.services["airquality"]["co2"]) {
        instance.co2 = getValue("airquality", "co2");
        instance.log.info("CO2 Density:  ", instance.co2, "µg/m³");
        instance.airQualityService.setCharacteristic(
          Characteristic.CarbonDioxideLevel,
          Math.round(instance.co2)
        );
      }
      if (!!instance.services["airquality"]["no2"]) {
        instance.no2 = getValue("airquality", "no2");
        instance.log.info("NO2 Density:  ", instance.no2, "µg/m³");
        instance.airQualityService.setCharacteristic(
          Characteristic.NitrogenDioxideDensity,
          Math.round(instance.no2)
        );
      }
      if (!!instance.services["airquality"]["o3"]) {
        instance.o3 = getValue("airquality", "o3");
        instance.log.info("O3 Density:   ", instance.o3, "µg/m³");
        instance.airQualityService.setCharacteristic(
          Characteristic.OzoneDensity,
          Math.round(instance.o3)
        );
      }
      if (!!instance.services["airquality"]["pm2.5"]) {
        instance.pm25 = getValue("airquality", "pm2.5");
        instance.log.info("PM2.5 Density:", instance.pm25, "µg/m³");
        instance.airQualityService.setCharacteristic(
          Characteristic.PM2_5Density,
          Math.round(instance.pm25)
        );
      }
      if (!!instance.services["airquality"]["pm10"]) {
        instance.pm10 = getValue("airquality", "pm10");
        instance.log.info("PM10 Density: ", instance.pm10, "µg/m³");
        instance.airQualityService.setCharacteristic(
          Characteristic.PM10Density,
          Math.round(instance.pm10)
        );
      }
      if (!!instance.services["airquality"]["so2"]) {
        instance.so2 = getValue("airquality", "so2");
        instance.log.info("SO2 Density:  ", instance.so2, "µg/m³");
        instance.airQualityService.setCharacteristic(
          Characteristic.SulphurDioxideDensity,
          Math.round(instance.so2)
        );
      }
      if (!!instance.services["airquality"]["voc"]) {
        instance.voc = getValue("airquality", "voc");
        instance.log.info("VOC Density:  ", instance.voc, "µg/m³");
        instance.airQualityService.setCharacteristic(
          Characteristic.VOCDensity,
          Math.round(instance.voc)
        );
      }
    }

    const calculateCaqi = function() {
      if (!!instance.services["airquality"]["no2"]
          || !!instance.services["airquality"]["pm10"]
          || !!instance.services["airquality"]["o3"]
          || !!instance.services["airquality"]["pm2.5"]) {
        var _no2, _pm10, _o3, _pm25;

        if (instance.no2 < 50) { _no2 = 0; }
        else if (instance.no2 < 100) { _no2 = 1; }
        else if (instance.no2 < 200) { _no2 = 2; }
        else if (instance.no2 < 400) { _no2 = 3; }
        else { _no2 = 4; }

        if (instance.pm10 < 25) { _pm10 = 0; }
        else if (instance.pm10 < 50) { _pm10 = 1; }
        else if (instance.pm10 < 90) { _pm10 = 2; }
        else if (instance.pm10 < 180) { _pm10 = 3; }
        else { _pm10 = 4; }

        if (instance.o3 < 60) { _o3 = 0; }
        else if (instance.o3 < 120) { _o3 = 1; }
        else if (instance.o3 < 180) { _o3 = 2; }
        else if (instance.o3 < 240) { _o3 = 3; }
        else { _o3 = 4; }

        if (instance.pm25 < 15) { _pm25 = 0; }
        else if (instance.pm25 < 30) { _pm25 = 1; }
        else if (instance.pm25 < 55) { _pm25 = 2; }
        else if (instance.pm25 < 110) { _pm25 = 3; }
        else { _pm25 = 4; }

        var aqi = Math.max(_no2, _pm10, _o3, _pm25);

        if (aqi == 0) {
          return Characteristic.AirQuality.EXCELLENT;
        } else if (aqi == 1) {
          return Characteristic.AirQuality.GOOD;
        } else if (aqi == 2) {
          return Characteristic.AirQuality.FAIR;
        } else if (aqi == 3) {
          return Characteristic.AirQuality.INFERIOR;
        } else if (aqi == 4) {
          return Characteristic.AirQuality.POOR;
        } else {
          return Characteristic.AirQuality.UNKNOWN;
        }
      } else {
        return Characteristic.AirQuality.UNKNOWN;
      }
    }.bind(this);

    if (!!instance.services["airquality"]) {
      switch (instance.services["airquality"]["aqi"] || "caqi") {
        case "caqi":
          instance.airQuality = calculateCaqi();
          break;
        default:
          instance.airQuality = Characteristic.AirQuality.UNKNOWN;
          instance.log.error("unknown aqi function " + instance.services["airquality"]["aqi"]);
          break;
      }
      instance.log.info("Air Quality:  ", instance.airQuality ? "*".repeat(6 - instance.airQuality) : "?");
      instance.airQualityService.setCharacteristic(
        Characteristic.AirQuality,
        instance.airQuality
      );
    }

    instance.updateHistoryCounter++;
    if (instance.updateHistoryCounter == instance.updateHistoryFrequency) {
      instance.updateHistoryCounter = 0;
      if (!!instance.services["temperature"] || !!instance.services["humidity"]) {
        var entry = {
           time: moment().unix(),
           temp: instance.temperature,
           pressure: instance.pressure,
           humidity: instance.humidity,
           // ppm: [instance.co, instance.co2, instance.no2, instance.o3, instance.pm25, instance.pm10, instance.so2, instance.voc].filter(val => val !== undefined && val != null).reduce((x, y) => x + y, 0)
        };
        instance.log.debug("Adding new history entry " + JSON.stringify(entry));
        instance.loggingService.addEntry(entry);
        if (!!instance.historyFilename) {
          const file = instance.historyPath + "/" + instance.historyFilename;
          instance.log.debug("Adding entry to history file " + file)
          if (!fs.existsSync(file)) {
            var line = "date;"
              + "time;"
              + "temperature;"
              + "humidity;"
              + "pressure;"
              + "co;"
              + "co2;"
              + "no2;"
              + "o3;"
              + "pm25;"
              + "pm10;"
              + "so2;"
              + "voc"
              + "\r\n";
            fs.appendFileSync(file, line, (error) => { instance.log.error(error); });
          }
          var line = moment().format("YYYY/MM/DD") + ";"
            + moment().format("HH:mm:ss") + ";"
            + instance.temperature + ";"
            + instance.humidity + ";"
            + instance.pressure + ";"
            + instance.co + ";"
            + instance.co2 + ";"
            + instance.no2 + ";"
            + instance.o3 + ";"
            + instance.pm25 + ";"
            + instance.pm10 + ";"
            + instance.so2 + ";"
            + instance.voc
            + "\r\n";
          fs.appendFileSync(file, line, (error) => { instance.log.error(error); });
        }
      }
    }

    callback();

  }.bind(this);

  instance.isUpdating = false;
  const update = function() {
    if (instance.isUpdating) { return; }
    instance.isUpdating = true;
    instance.error = false;
    updateData(function() {
      updateServices(function() {
        instance.isUpdating = false;
      })
    });    
  }.bind(this);

  const initSources = function(callback) {

    instance.isUpdating = true;

    instance.log.debug("Initializing all sources...");

    const init = (source, callback) => {
      instance.log.debug("instantiating " + JSON.stringify(source));
      instance.data[source["id"]] = {};
      switch (source["provider"]) {
        case "luftdaten.info":
          initLuftdatenInfo(source, callback);
          break;
        case "waqi.info":
          initWaqiInfo(source, callback);
          break;
        case "bme280":
          initBme280(source, callback);
          break;
        default:
          instance.log.error("Unknown provider " + source["provider"]);
          callback();
          break;
      }
    }

    const next = (remainingSources) => {
      if (!remainingSources.length) {
        instance.log.debug("Sucessfully initialized all sources.");
        instance.isUpdating = false;
        callback();
      } else {
        const [source, ...nextSources] = remainingSources;
        init(source, () => next(nextSources));
      }
    };

    next(instance.sources);
  };

  setInterval(update, instance.updateIntervalSeconds * 1000);
  initSources(update);

  /*if (!!instance.services["temperature"]) {
    instance.temperatureService
      .getCharacteristic(Characteristic.CurrentTemperature)
      .on("get", (callback) => {
        callback(null, instance.temperature);
      });
    if (!!instance.services["temperature"]["pressure"]) {
      instance.temperatureService
        .getCharacteristic(CustomCharacteristic.AirPressure)
        .on("get", (callback) => {
          callback(null, instance.pressure);
        });
    }
  }
  if (!!instance.services["humidity"]) {
    instance.humidityService
      .getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .on("get", (callback) => {
        callback(null, instance.humidity);
      });
  }
  if (!!instance.services["airquality"]) {
    instance.airQualityService
      .getCharacteristic(Characteristic.AirQuality)
      .on("get", (callback) => {
        callback(null, instance.airQuality);
      });
    if (!!instance.services["airquality"]["co"]) {
      instance.airQualityService
        .getCharacteristic(Characteristic.CarbonMonoxideLevel)
        .on("get", (callback) => {
          callback(null, instance.co);
        });
    }
    if (!!instance.services["airquality"]["co2"]) {
      instance.airQualityService
        .getCharacteristic(Characteristic.CarbonDioxideLevel)
        .on("get", (callback) => {
          callback(null, instance.co2);
        });
    }
    if (!!instance.services["airquality"]["no2"]) {
      instance.airQualityService
        .getCharacteristic(Characteristic.NitrogenDioxideDensity)
        .on("get", (callback) => {
          callback(null, instance.no2);
        });
    }
    if (!!instance.services["airquality"]["o3"]) {
      instance.airQualityService
        .getCharacteristic(Characteristic.OzoneDensity)
        .on("get", (callback) => {
          callback(null, instance.o3);
        });
    }
    if (!!instance.services["airquality"]["pm2.5"]) {
      instance.airQualityService
        .getCharacteristic(Characteristic.PM2_5Density)
        .on("get", (callback) => {
          callback(null, instance.pm25);
        });
    }
    if (!!instance.services["airquality"]["pm10"]) {
      instance.airQualityService
        .getCharacteristic(Characteristic.PM10Density)
        .on("get", (callback) => {
          callback(null, instance.pm10);
        });
    }
    if (!!instance.services["airquality"]["so2"]) {
      instance.airQualityService
        .getCharacteristic(Characteristic.SulphurDioxideDensity)
        .on("get", (callback) => {
          callback(null, instance.so2);
        });
    }
    if (!!instance.services["airquality"]["voc"]) {
      instance.airQualityService
        .getCharacteristic(Characteristic.VOCDensity)
        .on("get", (callback) => {
          callback(null, instance.voc);
        });
    }
  }*/
};

UnifiedAirQualityAccessory.prototype.getServices = function() {
  return [
    this.informationService,
    this.temperatureService,
    this.humidityService,
    this.loggingService,
    this.airQualityService
  ].filter(function(s) {
    return s !== undefined;
  });
};
