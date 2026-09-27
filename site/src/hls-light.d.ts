// The light build has the same API as the full one, minus subtitles,
// alternate audio and DRM, none of which these clips use.
declare module "hls.js/light" {
  import Hls from "hls.js";
  export default Hls;
}
