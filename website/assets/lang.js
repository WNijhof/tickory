// De startpagina kiest de taal: de eerste voorkeurstaal van de browser die Nederlands of Engels is, anders Engels.
// Er wordt niets onthouden; zonder JavaScript blijven de twee knoppen op de pagina staan.
(function () {
  var wanted = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ''];
  var lang = 'en';
  for (var i = 0; i < wanted.length; i++) {
    var code = (/^[a-z]+/.exec(String(wanted[i]).toLowerCase()) || [''])[0];
    if (code === 'nl' || code === 'en') {
      lang = code;
      break;
    }
  }
  location.replace(lang + '/' + location.search + location.hash);
})();
