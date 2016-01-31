/**
 * The copyright in this software is being made available under the BSD License,
 * included below. This software may be subject to other third party and contributor
 * rights, including patent rights, and no such rights are granted under this license.
 *
 * Copyright (c) 2013, Dash Industry Forum.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *  * Redistributions of source code must retain the above copyright notice, this
 *  list of conditions and the following disclaimer.
 *  * Redistributions in binary form must reproduce the above copyright notice,
 *  this list of conditions and the following disclaimer in the documentation and/or
 *  other materials provided with the distribution.
 *  * Neither the name of Dash Industry Forum nor the names of its
 *  contributors may be used to endorse or promote products derived from this software
 *  without specific prior written permission.
 *
 *  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS AS IS AND ANY
 *  EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 *  WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 *  IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
 *  INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 *  NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 *  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 *  WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 *  ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 *  POSSIBILITY OF SUCH DAMAGE.
 */
import DashHandler from '../DashHandler.js';
import DashManifestExtensions from '../extensions/DashManifestExtensions.js';
import DashMetricsExtensions from '../extensions/DashMetricsExtensions.js';
import TimelineConverter from '../TimelineConverter.js';
import AbrController from '../../streaming/controllers/AbrController.js';
import PlaybackController from '../../streaming/controllers/PlaybackController.js';
import StreamController from '../../streaming/controllers/StreamController.js';
import ManifestModel from '../../streaming/models/ManifestModel.js';
import MetricsModel from '../../streaming/models/MetricsModel.js';
import MediaPlayerModel from '../../streaming/models/MediaPlayerModel.js';
import DOMStorage from '../../streaming/utils/DOMStorage.js';
import Error from '../../streaming/vo/Error.js';
import EventBus from '../../core/EventBus.js';
import Events from '../../core/events/Events.js';
import FactoryMaker from '../../core/FactoryMaker.js';

function RepresentationController() {

    const SEGMENTS_UPDATE_FAILED_ERROR_CODE = 1;

    let context = this.context;
    let eventBus = EventBus(context).getInstance();

    let instance,
        data,
        dataIndex,
        updating,
        availableRepresentations,
        currentRepresentation,
        streamProcessor,
        abrController,
        indexHandler,
        streamController,
        playbackController,
        manifestModel,
        metricsModel,
        domStorage,
        timelineConverter,
        manifestExt,
        metricsExt,
        mediaPlayerModel;

    function setup() {
        data = null;
        dataIndex = -1;
        updating = true;
        availableRepresentations = [];

        abrController = AbrController(context).getInstance();
        streamController = StreamController(context).getInstance();
        playbackController = PlaybackController(context).getInstance();
        manifestModel = ManifestModel(context).getInstance();
        metricsModel = MetricsModel(context).getInstance();
        domStorage = DOMStorage(context).getInstance();
        timelineConverter = TimelineConverter(context).getInstance();
        manifestExt = DashManifestExtensions(context).getInstance();
        metricsExt = DashMetricsExtensions(context).getInstance();
        mediaPlayerModel = MediaPlayerModel(context).getInstance();

        eventBus.on(Events.QUALITY_CHANGED, onQualityChanged, instance);
        eventBus.on(Events.REPRESENTATION_UPDATED, onRepresentationUpdated, instance);
        eventBus.on(Events.WALLCLOCK_TIME_UPDATED, onWallclockTimeUpdated, instance);
        eventBus.on(Events.BUFFER_LEVEL_UPDATED, onBufferLevelUpdated, instance);
    }

    function initialize(StreamProcessor) {
        streamProcessor = StreamProcessor;
        indexHandler = streamProcessor.getIndexHandler();
    }

    function getStreamProcessor() {
        return streamProcessor;
    }

    function getData() {
        return data;
    }

    function getDataIndex() {
        return dataIndex;
    }

    function isUpdating() {
        return updating;
    }

    function getCurrentRepresentation() {
        return currentRepresentation;
    }

    function reset() {

        eventBus.off(Events.QUALITY_CHANGED, onQualityChanged, instance);
        eventBus.off(Events.REPRESENTATION_UPDATED, onRepresentationUpdated, instance);
        eventBus.off(Events.BUFFER_LEVEL_UPDATED, onBufferLevelUpdated, instance);
        eventBus.off(Events.LIVE_EDGE_SEARCH_COMPLETED, onLiveEdgeSearchCompleted, instance);

        data = null;
        dataIndex = -1;
        updating = true;
        availableRepresentations = [];
        abrController = null;
        streamController = null;
        playbackController = null;
        manifestModel = null;
        metricsModel = null;
        domStorage = null;
        timelineConverter = null;
        manifestExt = null;
        metricsExt = null;
        mediaPlayerModel = null;

    }

    function updateData(dataValue, adaptation, type) {
        var quality,
            averageThroughput;

        var bitrate = null;
        var streamInfo = streamProcessor.getStreamInfo();
        var maxQuality = abrController.getTopQualityIndexFor(type, streamInfo.id);

        updating = true;
        eventBus.trigger(Events.DATA_UPDATE_STARTED, {sender: this});

        availableRepresentations = updateRepresentations(adaptation);

        if (data === null) {
            averageThroughput = abrController.getAverageThroughput(type);
            bitrate = averageThroughput || abrController.getInitialBitrateFor(type, streamInfo);
            quality = abrController.getQualityForBitrate(streamProcessor.getMediaInfo(), bitrate);
        } else {
            quality = abrController.getQualityFor(type, streamInfo);
        }

        if (quality > maxQuality) {
            quality = maxQuality;
        }

        currentRepresentation = getRepresentationForQuality(quality);
        data = dataValue;

        if (type !== 'video' && type !== 'audio' && type !== 'fragmentedText') {
            updating = false;
            eventBus.trigger(Events.DATA_UPDATE_COMPLETED, {sender: this, data: data, currentRepresentation: currentRepresentation});
            return;
        }

        for (var i = 0; i < availableRepresentations.length; i++) {
            indexHandler.updateRepresentation(availableRepresentations[i], true);
        }
    }

    function addRepresentationSwitch() {
        var now = new Date();
        var currentRepresentation = getCurrentRepresentation();
        var currentVideoTimeMs = playbackController.getTime() * 1000;

        metricsModel.addRepresentationSwitch(currentRepresentation.adaptation.type, now, currentVideoTimeMs, currentRepresentation.id);
    }

    function addDVRMetric() {
        var range = timelineConverter.calcSegmentAvailabilityRange(currentRepresentation, streamProcessor.isDynamic());
        metricsModel.addDVRInfo(streamProcessor.getType(), playbackController.getTime(), streamProcessor.getStreamInfo().manifestInfo, range);
    }

    function getRepresentationForQuality(quality) {
        return availableRepresentations[quality];
    }

    function getQualityForRepresentation(representation) {
        return availableRepresentations.indexOf(representation);
    }

    function isAllRepresentationsUpdated() {
        for (var i = 0, ln = availableRepresentations.length; i < ln; i++) {
            var segmentInfoType = availableRepresentations[i].segmentInfoType;
            if (availableRepresentations[i].segmentAvailabilityRange === null || availableRepresentations[i].initialization === null ||
                    ((segmentInfoType === 'SegmentBase' || segmentInfoType === 'BaseURL') && !availableRepresentations[i].segments)
            ) {
                return false;
            }
        }

        return true;
    }

    function updateRepresentations(adaptation) {
        var reps;
        var manifest = manifestModel.getValue();

        dataIndex = manifestExt.getIndexForAdaptation(data, manifest, adaptation.period.index);
        reps = manifestExt.getRepresentationsForAdaptation(manifest, adaptation);

        return reps;
    }

    function updateAvailabilityWindow(isDynamic) {
        var rep;

        for (var i = 0, ln = availableRepresentations.length; i < ln; i++) {
            rep = availableRepresentations[i];
            rep.segmentAvailabilityRange = timelineConverter.calcSegmentAvailabilityRange(rep, isDynamic);
        }
    }

    function postponeUpdate(availabilityDelay) {
        var delay = (availabilityDelay + (currentRepresentation.segmentDuration * mediaPlayerModel.getLiveDelayFragmentCount())) * 1000;
        var update = function () {
            if (isUpdating()) return;

            updating = true;
            eventBus.trigger(Events.DATA_UPDATE_STARTED, { sender: instance });

            for (var i = 0; i < availableRepresentations.length; i++) {
                indexHandler.updateRepresentation(availableRepresentations[i], true);
            }
        };

        updating = false;
        eventBus.trigger(Events.AST_IN_FUTURE, { delay: delay });
        setTimeout(update, delay);
    }

    function onRepresentationUpdated(e) {
        if (e.sender.getStreamProcessor() !== streamProcessor || !isUpdating()) return;

        var r = e.representation;
        var streamMetrics = metricsModel.getMetricsFor('stream');
        var metrics = metricsModel.getMetricsFor(getCurrentRepresentation().adaptation.type);
        var manifestUpdateInfo = metricsExt.getCurrentManifestUpdate(streamMetrics);

        var repInfo,
            err,
            repSwitch;
        var alreadyAdded = false;

        if (e.error && e.error.code === DashHandler.SEGMENTS_UNAVAILABLE_ERROR_CODE) {
            addDVRMetric();
            postponeUpdate(e.error.data.availabilityDelay);
            err = new Error(SEGMENTS_UPDATE_FAILED_ERROR_CODE, 'Segments update failed', null);
            eventBus.trigger(Events.DATA_UPDATE_COMPLETED, {sender: this, data: data, currentRepresentation: currentRepresentation, error: err});

            return;
        }

        if (manifestUpdateInfo) {
            for (var i = 0; i < manifestUpdateInfo.trackInfo.length; i++) {
                repInfo = manifestUpdateInfo.trackInfo[i];
                if (repInfo.index === r.index && repInfo.mediaType === streamProcessor.getType()) {
                    alreadyAdded = true;
                    break;
                }
            }

            if (!alreadyAdded) {
                metricsModel.addManifestUpdateRepresentationInfo(manifestUpdateInfo, r.id, r.index, r.adaptation.period.index,
                        streamProcessor.getType(),r.presentationTimeOffset, r.startNumber, r.segmentInfoType);
            }
        }

        if (isAllRepresentationsUpdated()) {
            updating = false;
            abrController.setPlaybackQuality(streamProcessor.getType(), streamProcessor.getStreamInfo(), getQualityForRepresentation(currentRepresentation));
            metricsModel.updateManifestUpdateInfo(manifestUpdateInfo, {latency: currentRepresentation.segmentAvailabilityRange.end - playbackController.getTime()});

            repSwitch = metricsExt.getCurrentRepresentationSwitch(metrics);

            if (!repSwitch) {
                addRepresentationSwitch();
            }

            eventBus.trigger(Events.DATA_UPDATE_COMPLETED, {sender: this, data: data, currentRepresentation: currentRepresentation});
        }
    }

    function onWallclockTimeUpdated(e) {
        if (e.isDynamic) {
            updateAvailabilityWindow(e.isDynamic);
        }
    }

    function onLiveEdgeSearchCompleted(e) {
        if (e.error) return;

        updateAvailabilityWindow(true);
        indexHandler.updateRepresentation(currentRepresentation, false);

        // we need to update checkTime after we have found the live edge because its initial value
        // does not take into account clientServerTimeShift
        var manifest = manifestModel.getValue();
        var period = currentRepresentation.adaptation.period;
        var streamInfo = streamController.getActiveStreamInfo();

        if (streamInfo.isLast) {
            period.mpd.checkTime = manifestExt.getCheckTime(manifest, period);
            period.duration = manifestExt.getEndTimeForLastPeriod(manifestModel.getValue(), period) - period.start;
            streamInfo.duration = period.duration;
        }
    }

    function onBufferLevelUpdated(e) {
        if (e.sender.getStreamProcessor() !== streamProcessor) return;
        addDVRMetric();
    }

    function onQualityChanged(e) {
        if (e.mediaType !== streamProcessor.getType() || streamProcessor.getStreamInfo().id !== e.streamInfo.id) return;

        if (e.oldQuality !== e.newQuality) {
            currentRepresentation = getRepresentationForQuality(e.newQuality);
            setLocalStorage(e.mediaType, currentRepresentation.bandwidth);
            addRepresentationSwitch();
        }
    }

    function setLocalStorage(type, bitrate) {
        if (domStorage.isSupported(DOMStorage.STORAGE_TYPE_LOCAL) && (type === 'video' || type === 'audio')) {
            localStorage.setItem(DOMStorage['LOCAL_STORAGE_' + type.toUpperCase() + '_BITRATE_KEY'], JSON.stringify({bitrate: bitrate / 1000, timestamp: new Date().getTime()}));
        }
    }

    instance = {
        initialize: initialize,
        getData: getData,
        getDataIndex: getDataIndex,
        isUpdating: isUpdating,
        updateData: updateData,
        getStreamProcessor: getStreamProcessor,
        getCurrentRepresentation: getCurrentRepresentation,
        getRepresentationForQuality: getRepresentationForQuality,
        reset: reset
    };

    setup();
    return instance;
}

RepresentationController.__dashjs_factory_name = 'RepresentationController';
export default FactoryMaker.getClassFactory(RepresentationController);
