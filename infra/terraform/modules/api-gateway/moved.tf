# La ruta {proxy+} de la API pública pasó a llamarse public-spa (misma ruta, método e
# integración): se mueve en el estado en lugar de recrearse.
moved {
  from = aws_api_gateway_resource.proxy["public"]
  to   = aws_api_gateway_resource.route["public-spa"]
}

moved {
  from = aws_api_gateway_method.proxy["public"]
  to   = aws_api_gateway_method.route["public-spa"]
}

moved {
  from = aws_api_gateway_integration.proxy["public"]
  to   = aws_api_gateway_integration.route["public-spa"]
}
