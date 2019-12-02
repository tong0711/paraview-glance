import JSZip from 'jszip';
import Vue from 'vue';
import Vuex from 'vuex';

import vtk from 'vtk.js/Sources/vtk';
import vtkProxyManager from 'vtk.js/Sources/Proxy/Core/ProxyManager';

import ReaderFactory from 'paraview-glance/src/io/ReaderFactory';
import Config from 'paraview-glance/src/config';
import global from 'paraview-glance/src/store/globalSettings';
import files from 'paraview-glance/src/store/fileLoader';
import screenshots from 'paraview-glance/src/store/screenshots';
import views from 'paraview-glance/src/store/views';
import { Actions, Mutations } from 'paraview-glance/src/store/types';

// http://jsperf.com/typeofvar
function typeOf(o) {
  return {}.toString
    .call(o)
    .slice(8, -1)
    .toLowerCase();
}

// quick object merge using Vue.set
/* eslint-disable no-param-reassign */
function merge(dst, src) {
  const keys = Object.keys(src);
  for (let i = 0; i < keys.length; ++i) {
    const key = keys[i];
    if (typeOf(dst[key]) === 'object' && typeOf(src[key]) === 'object') {
      Vue.set(dst, key, merge(dst[key], src[key]));
    } else {
      Vue.set(dst, key, src[key]);
    }
  }
  return dst;
}
/* eslint-enable no-param-reassign */

// Reduces app state to relevant persistent state
function reduceState(state) {
  return {
    route: state.route,
    global: state.global,
    views: state.views,
  };
}

function getModuleDefinitions() {
  return {
    global,
    files,
    screenshots,
    views,
  };
}

function changeActiveSliceDelta(proxyManager, delta) {
  const view = proxyManager.getActiveView();
  if (view.isA('vtkView2DProxy')) {
    const sliceReps = view
      .getRepresentations()
      .filter((r) => r.isA('vtkSliceRepresentationProxy'));
    if (sliceReps.length) {
      const rep = sliceReps[0];
      rep.setSlice(rep.getSlice() + delta);
    }
  }
}

export function registerProxyManagerHooks(pxm, store) {
  const subs = [];
  const modules = getModuleDefinitions();
  const hookNames = ['onProxyRegistrationChange'];

  Object.keys(modules)
    .filter((mod) => Boolean(modules[mod].proxyManagerHooks))
    .forEach((mod) => {
      const hooks = modules[mod].proxyManagerHooks;
      hookNames
        .filter((name) => Boolean(hooks[name]))
        .forEach((hookName) =>
          subs.push(pxm[hookName](hooks[hookName](store)))
        );
    });

  return () => {
    while (subs.length) {
      subs.pop().unsubscribe();
    }
  };
}

function createStore(proxyManager = null) {
  let pxm = proxyManager;
  if (!proxyManager) {
    pxm = vtkProxyManager.newInstance({
      proxyConfiguration: Config.Proxy,
    });
  }

  return new Vuex.Store({
    state: {
      proxyManager: pxm,
      route: 'landing', // valid values: landing, app
      savingStateName: null,
      loadingState: false,
      panels: {},
      cameraViewPoints: {},
    },
    getters: {
      CAMERA_VIEW_POINTS(state) {
        return state.cameraViewPoints;
      },
      PROXY_MANAGER(state) {
        return state.proxyManager;
      },
    },
    modules: getModuleDefinitions(),
    mutations: {
      SHOW_LANDING(state) {
        state.route = 'landing';
      },
      SHOW_APP(state) {
        state.route = 'app';
      },
      SAVING_STATE(state, name = null) {
        state.savingStateName = name;
      },
      LOADING_STATE(state, flag) {
        state.loadingState = flag;
      },
      ADD_PANEL: (state, { component, priority = 0 }) => {
        if (!(priority in state.panels)) {
          Vue.set(state.panels, priority, []);
        }
        state.panels[priority].push(component);
      },
    },
    actions: {
      SAVE_STATE({ commit, state }, fileNameToUse) {
        const t = new Date();
        const fileName =
          fileNameToUse ||
          `${t.getFullYear()}${t.getMonth() +
            1}${t.getDate()}_${t.getHours()}-${t.getMinutes()}-${t.getSeconds()}.glance`;

        commit(Mutations.SAVING_STATE, fileName);

        const userData = reduceState(state);
        const options = {
          recycleViews: true,
          datasetHandler(dataset, source) {
            const sourceMeta = source.get('name', 'url', 'remoteMetaData');
            const datasetMeta = dataset.get('name', 'url', 'remoteMetaData');
            const metadata = sourceMeta.url ? sourceMeta : datasetMeta;
            if (metadata.name && metadata.url) {
              return metadata;
            }
            // Not a remote dataset so use basic dataset serialization
            return dataset.getState();
          },
        };

        const zip = new JSZip();
        state.proxyManager.saveState(options, userData).then((stateObject) => {
          zip.file('state.json', JSON.stringify(stateObject));
          zip
            .generateAsync({
              type: 'blob',
              compression: 'DEFLATE',
              compressionOptions: {
                level: 6,
              },
            })
            .then((blob) => {
              console.log('file generated', this.fileName, blob.size);
              const url = URL.createObjectURL(blob);
              const anchor = document.createElement('a');
              anchor.setAttribute('href', url);
              anchor.setAttribute('download', fileName);

              document.body.appendChild(anchor);
              anchor.click();
              document.body.removeChild(anchor);

              setTimeout(() => URL.revokeObjectURL(url), 60000);
              commit(Mutations.SAVING_STATE, null);
            });
        });
      },
      RESTORE_APP_STATE({ commit, dispatch, state }, appState) {
        commit(Mutations.LOADING_STATE, true);

        dispatch(Actions.RESET_WORKSPACE);
        return state.proxyManager
          .loadState(appState, {
            datasetHandler(ds) {
              if (ds.vtkClass) {
                return vtk(ds);
              }
              return ReaderFactory.downloadDataset(ds.name, ds.url)
                .then((file) => ReaderFactory.loadFiles([file]))
                .then((readers) => readers[0])
                .then(({ dataset, reader }) => {
                  if (reader && reader.getOutputData) {
                    const newDS = reader.getOutputData();
                    newDS.set(ds, true); // Attach remote data origin
                    return newDS;
                  }
                  if (dataset && dataset.isA) {
                    dataset.set(ds, true); // Attach remote data origin
                    return dataset;
                  }
                  if (reader && reader.setProxyManager) {
                    reader.setProxyManager(state.proxyManager);
                    return null;
                  }
                  throw new Error('Invalid dataset');
                })
                .catch((e) => {
                  // more meaningful error
                  const moreInfo = `Dataset doesn't exist or adblock/firewall prevents access.`;
                  if ('xhr' in e) {
                    const { xhr } = e;
                    throw new Error(
                      `${xhr.statusText} (${xhr.status}): ${moreInfo}`
                    );
                  }
                  throw new Error(`${e.message} (${moreInfo})`);
                });
            },
          })
          .then((userData) => {
            this.replaceState(merge(state, userData));

            // Wait for the layout to be done (nextTick is not enough)
            setTimeout(() => {
              // Advertise that state loading is done
              commit(Mutations.LOADING_STATE, false);

              // Force update
              state.proxyManager.modified();

              // Activate visible view with a preference for the 3D one
              const visibleViews = state.proxyManager
                .getViews()
                .filter((view) => view.getContainer());
              const view3D = visibleViews.find(
                (view) => view.getProxyName() === 'View3D'
              );
              const viewToActivate = view3D || visibleViews[0];
              if (viewToActivate) {
                viewToActivate.activate();
              }

              // Make sure pre-existing view (not expected in state) have a representation
              state.proxyManager
                .getSources()
                .forEach(state.proxyManager.createRepresentationInAllViews);
            }, 100);
          });
      },
      RESET_WORKSPACE({ state }) {
        // use setTimeout to avoid some weird crashing with extractDomains
        state.proxyManager
          .getSources()
          .forEach((source) =>
            setTimeout(() => state.proxyManager.deleteProxy(source), 0)
          );
        setTimeout(() => {
          state.proxyManager.renderAllViews();
          state.proxyManager.resetCameraInAllViews();
        }, 0);
      },
      RESET_ACTIVE_CAMERA({ state }) {
        state.proxyManager.resetCamera();
      },
      SET_CAMERA_VIEW_POINTS({ state }, viewPoints) {
        state.cameraViewPoints = viewPoints;
      },
      CHANGE_CAMERA_VIEW_POINT({ getters, state }, viewPointKey) {
        const allViews = state.proxyManager.getViews();
        const pxManager = getters.PROXY_MANAGER;

        const viewPoints = getters.CAMERA_VIEW_POINTS[viewPointKey] || {};
        const camera = viewPoints.camera;
        const showSources = viewPoints.show;
        const hideSources = viewPoints.hide;

        const moveCameraPromiseList = [];

        allViews
          .filter((v) => v.getName() === 'default')
          .forEach((v) => {
            const promise = v.moveCamera(
              camera.focalPoint,
              camera.position,
              camera.viewUp,
              100
            );
            moveCameraPromiseList.push(promise);
          });

        Promise.all(moveCameraPromiseList).then(() => {
          // Modify the source visibilities from the view point settings
          pxManager.getSources().forEach((source) => {
            const name = source.getName();

            if (!showSources.includes(name) && !hideSources.includes(name)) {
              // Don't change the visibility
              return;
            }

            const visible = showSources.includes(name);

            const rep = pxManager
              .getRepresentations()
              .filter((r) => r.getInput() === source)[0];

            if (rep.getVisibility() !== visible) {
              rep.setVisibility(visible);
            }
          });

          pxManager.renderAllViews();
        });
      },
      INCREASE_SLICE({ state }) {
        if (state.route === 'app') {
          changeActiveSliceDelta(proxyManager, 1);
        }
      },
      DECREASE_SLICE({ state }) {
        if (state.route === 'app') {
          changeActiveSliceDelta(proxyManager, -1);
        }
      },
    },
  });
}

export default createStore;
