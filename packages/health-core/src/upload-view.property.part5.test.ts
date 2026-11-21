/**
 * One range of the list-view property's seeds (US-52 AC8c, US-13 AC13). The harness, its properties and the mutations
 * each was shown failing on: upload-view.property.test-helpers.ts.
 */
import { sweepPart } from './upload-view.property.test-helpers';

// UPLOAD_VIEW_PROPERTY_OUT: a path the reach and the known gaps seen are written to.
sweepPart(5, process.env.UPLOAD_VIEW_PROPERTY_OUT);
